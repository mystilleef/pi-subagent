/**
 * Manages subagent execution by spawning and orchestrating child `pi` processes.
 * Handles JSON-mode event streaming, resource tracking, and lifecycle management
 * including timeouts and termination signals.
 */

import { type ChildProcess, spawn } from "node:child_process";
import readline from "node:readline";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig, ThinkingLevel } from "../agent/agents.js";
import { getFinalOutput } from "../output/ui.js";
import { serializeSamplingParams } from "../shared/sampling.js";
import {
  type OnUpdateCallback,
  type SingleResult,
  type SubagentDetails,
  TOOL_RESULT_FAILED_MESSAGE,
} from "../shared/types.js";
import {
  detectMessageError,
  getPiInvocation,
  getSubagentDepth,
  getSubagentRuntimeLimits,
  resolveAgentSkillArgs,
  subagentDepthEnv,
} from "../shared/utils.js";
import {
  type ChildEventParseResult,
  type ChildKnownEvent,
  parseChildEventLine,
  TOOL_EXECUTION_UPDATE_EVENT,
} from "./child-events.js";
import { getLatestOutcomeFromMessages } from "./complete-outcome.js";
import {
  buildModelDisplay,
  type ChildModelSettings,
  resolveEffectiveChildModelSettings,
  resolveThinkingLevel,
} from "./model-resolution.js";
import {
  appendWithByteLimit,
  resolveCompleteExtensionPath,
  resolveSamplingExtensionPath,
} from "./process-utils.js";
import { appendSubagentResultContract } from "./prompt-contract.js";
import {
  beginPromptSetup,
  cleanupPromptSetupResult,
  cleanupTempPrompt,
} from "./prompt-setup.js";
import {
  addMessageToResult,
  createErrorResult,
  errorForDepthLimit,
  errorForUnknownAgent,
  initRuntimeResult,
  type RuntimeResult,
  rebuildResultFromMessages,
} from "./result-builder.js";
import { type EmitUpdateFn, makeEmitUpdate } from "./streaming-progress.js";
import {
  acquireChildSleepInhibitor,
  getProcessTreeSpawnOptions,
  isFinitePid,
  makeHostSleepInhibitorAdapter,
  type SleepInhibitorHandle,
  terminateChildProcess,
} from "./termination.js";

const COMPLETE_EXTENSION_PATH = resolveCompleteExtensionPath();
const SAMPLING_EXTENSION_PATH = resolveSamplingExtensionPath();

export { resolveThinkingLevel } from "./model-resolution.js";
export { makeEmitUpdate } from "./streaming-progress.js";

type RuntimeLimits = ReturnType<typeof getSubagentRuntimeLimits>;
type SleepInhibitorAcquirer = (pid: number) => Promise<SleepInhibitorHandle>;

type RunSingleAgentOptions = {
  acquireSleepInhibitor?: SleepInhibitorAcquirer;
  getOrchestratorPid?: () => unknown;
};

export type RunSingleAgentResult =
  | { kind: "completed"; result: SingleResult }
  | { kind: "aborted"; result: SingleResult };

interface SubagentState {
  result: RuntimeResult;
  runtimeLimits: RuntimeLimits;
  spawnError?: Error;
  wasAborted: boolean;
  agentEndGraceTimer?: ReturnType<typeof setTimeout>;
  terminationPromise?: Promise<unknown>;
}

function getAbortReason(signal: AbortSignal): string {
  const { reason } = signal;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "abort";
}

const hostSleepInhibitorAdapter = makeHostSleepInhibitorAdapter();

async function acquireDefaultSleepInhibitor(
  pid: number,
): Promise<SleepInhibitorHandle> {
  return acquireChildSleepInhibitor(pid, hostSleepInhibitorAdapter);
}

async function acquireSubagentSleepInhibitor(
  pid: number,
  acquireSleepInhibitor: SleepInhibitorAcquirer,
): Promise<SleepInhibitorHandle | undefined> {
  try {
    return await acquireSleepInhibitor(pid);
  } catch {
    /* acquisition failures degrade gracefully to no inhibitor */
    return undefined;
  }
}

function getValidatedOrchestratorPid(
  options: RunSingleAgentOptions,
): number | undefined {
  try {
    const pid = options.getOrchestratorPid
      ? options.getOrchestratorPid()
      : process.pid;
    return isFinitePid(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function releaseSleepInhibitor(
  handle: SleepInhibitorHandle | undefined,
): Promise<void> {
  if (!handle) return;
  try {
    await handle.release();
  } catch {
    /* release failures are non-fatal */
  }
}

function startSleepInhibitorRelease(
  acquisitionPromise: Promise<SleepInhibitorHandle | undefined>,
): Promise<void> {
  return acquisitionPromise.then(releaseSleepInhibitor, () => {});
}

export function hasCompletedAgentOutput(
  result: RuntimeResult,
  outcome?: string,
): boolean {
  if (result.finalOutput.trim()) return true;
  if (outcome?.trim()) return true;
  return getFinalOutput(result.messages).trim().length > 0;
}

/**
 * Rationale: `pi` processes in JSON mode might hang after finishing their task;
 * we force-kill them after a grace period and treat it as success (0) if they
 * actually produced output.
 */
export function getAgentEndTimeoutExitCode(
  result: RuntimeResult,
  spawnError: Error | undefined,
  outcome: string | undefined,
): number | undefined {
  if (result.termination?.cancelReason !== "agent_end_timeout") return;
  if (spawnError) return;
  if (result.stopReason === "error" || result.stopReason === "aborted") return;
  if (result.errorMessage?.trim()) return;
  return hasCompletedAgentOutput(result, outcome) ? 0 : 1;
}

/**
 * Safety: Implements a dual-timer strategy (idle and hard) to ensure streams
 * are destroyed and promises settled even if the process or its pipes hang.
 */
function createProcessCleanup(proc: ChildProcess, idleMs: number) {
  let idleTimer: NodeJS.Timeout | undefined;
  const destroyStreams = () => {
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  };
  return {
    armIdleTimer: () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(destroyStreams, idleMs);
      idleTimer.unref?.();
    },
    clearIdleTimer: () => {
      if (idleTimer) clearTimeout(idleTimer);
    },
    destroyStreams,
  };
}

async function waitForSubagentProcess(
  proc: ChildProcess,
  idleMs = 100,
  hardMs = 5_000,
): Promise<number | null> {
  return new Promise((resolve) => {
    let exitCode: number | null = null;
    let exited = false;
    let settled = false;
    const cleanup = createProcessCleanup(proc, idleMs);
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup.clearIdleTimer();
      resolve(exitCode);
    };
    proc.on("close", done);
    proc.on("error", () => {
      exitCode = 1;
      exited = true;
      done();
    });
    proc.on("exit", (code) => {
      exitCode = code;
      exited = true;
      cleanup.armIdleTimer();
      const hardTimer = setTimeout(cleanup.destroyStreams, hardMs);
      hardTimer.unref?.();
    });
    const onStreamData = () => {
      if (exited) cleanup.armIdleTimer();
    };
    proc.stdout?.on("data", onStreamData);
    proc.stderr?.on("data", onStreamData);
  });
}

function makeRequestTerminator(
  proc: ChildProcess,
  terminateOptions: {
    tree: boolean;
    platform: NodeJS.Platform;
    processTreeDetached: boolean;
  },
  state: SubagentState,
): (reason: string) => Promise<unknown> {
  return (reason: string) => {
    state.terminationPromise ??= terminateChildProcess(proc, {
      ...terminateOptions,
      reason,
    }).then((metadata) => {
      state.result.termination = metadata;
    });
    return state.terminationPromise;
  };
}

function clearGraceTimer(state: SubagentState): void {
  if (!state.agentEndGraceTimer) return;
  clearTimeout(state.agentEndGraceTimer);
  delete state.agentEndGraceTimer;
}

function handleMessageEvent(
  event: ChildKnownEvent,
  state: SubagentState,
  emitUpdate: EmitUpdateFn,
): void {
  if (event.type !== "message_end" && event.type !== "tool_result_end") return;
  if (event.message) {
    addMessageToResult(state.result, event.message as Message);
    const toolResultCompleted = event.type === "tool_result_end";
    emitUpdate({ toolResultCompleted });
  }
}

function handleToolExecutionUpdateEvent(
  event: ChildKnownEvent,
  emitUpdate: EmitUpdateFn,
): void {
  if (event.type !== TOOL_EXECUTION_UPDATE_EVENT) return;
  emitUpdate({ toolActivity: event.toolActivity });
}

function handleAgentEndEvent(
  event: ChildKnownEvent,
  state: SubagentState,
  emitUpdate: EmitUpdateFn,
  requestTermination: (reason: string) => Promise<unknown>,
): void {
  if (event.type !== "agent_end") return;
  if (Array.isArray(event.messages) && event.messages.length > 0) {
    rebuildResultFromMessages(state.result, event.messages as Message[]);
    emitUpdate();
  }
  if (state.agentEndGraceTimer || state.terminationPromise) return;
  state.agentEndGraceTimer = setTimeout(() => {
    delete state.agentEndGraceTimer;
    void requestTermination("agent_end_timeout");
  }, state.runtimeLimits.agentEndGraceMs);
  state.agentEndGraceTimer.unref?.();
}

function formatUnknownEventDiagnostic(
  line: string,
  parseResult: Exclude<ChildEventParseResult, { kind: "known" }>,
): string {
  if (parseResult.kind === "invalid" && !line.trim()) {
    return "[pi-subagent:unknown-event] blank";
  }
  if (parseResult.kind === "invalid") {
    return `[pi-subagent:unknown-event] malformed: ${line}`;
  }
  return `[pi-subagent:unknown-event] unknown: ${JSON.stringify(parseResult.event)}`;
}

function processEventLine(
  line: string,
  state: SubagentState,
  emitUpdate: EmitUpdateFn,
  requestTermination: (reason: string) => Promise<unknown>,
  debugEventDiagnostics: boolean,
): void {
  const parseResult = parseChildEventLine(line);
  if (parseResult.kind !== "known") {
    if (debugEventDiagnostics) {
      process.stderr.write(
        `${formatUnknownEventDiagnostic(line, parseResult)}\n`,
      );
    }
    return;
  }
  const { event } = parseResult;
  handleMessageEvent(event, state, emitUpdate);
  handleToolExecutionUpdateEvent(event, emitUpdate);
  handleAgentEndEvent(event, state, emitUpdate, requestTermination);
}

function setupAbortHandler(
  signal: AbortSignal | undefined,
  state: SubagentState,
  clearTimer: () => void,
  requestTermination: (reason: string) => Promise<unknown>,
): (() => void) | undefined {
  if (!signal) return undefined;
  const onAbort = () => {
    state.wasAborted = true;
    clearTimer();
    void requestTermination(getAbortReason(signal));
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return onAbort;
}

function buildSamplingEnv(agent: AgentConfig): string | undefined {
  return serializeSamplingParams({
    temperature: agent.temperature,
    topP: agent.topP,
  });
}

function buildPiArgs(
  agent: AgentConfig,
  task: string,
  effectiveModel: ChildModelSettings,
  thinking: ThinkingLevel,
  resolvedSkills: { args: string[] },
  tmpPrompt: { filePath: string } | null,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--approve",
    "--no-themes",
    "--no-prompt-templates",
  ];
  if (effectiveModel.provider && effectiveModel.id)
    args.push("--provider", effectiveModel.provider);
  if (effectiveModel.id) args.push("--model", effectiveModel.id);
  args.push("--thinking", thinking);
  if (agent.tools) {
    const tools = new Set(agent.tools);
    tools.add("complete");
    args.push("--tools", [...tools].join(","));
  }
  if (agent.skills !== undefined)
    args.push("--no-skills", ...resolvedSkills.args);
  if (agent.context === false) args.push("--no-context-files");
  if (tmpPrompt) {
    args.push("--append-system-prompt", tmpPrompt.filePath);
  }
  args.push("--extension", COMPLETE_EXTENSION_PATH);
  const taskPrompt = task
    ? `Task: ${task}`
    : "Run according to your system prompt. If no explicit task was provided, use the default context described there.";
  args.push(appendSubagentResultContract(taskPrompt));
  return args;
}

function buildChildEnv(samplingEnv: string | undefined): NodeJS.ProcessEnv {
  const { PI_SAMPLING_PARAMS: _, ...parentEnv } = process.env;
  return {
    ...parentEnv,
    ...subagentDepthEnv(),
    ...(samplingEnv ? { PI_SAMPLING_PARAMS: samplingEnv } : {}),
  };
}

function setupChildProcess(
  proc: ChildProcess,
  state: SubagentState,
  emitUpdate: EmitUpdateFn,
  requestTermination: (reason: string) => Promise<unknown>,
  debugEventDiagnostics: boolean,
): void {
  proc.once("error", (error) => {
    state.spawnError = error;
    state.result.stderr = appendWithByteLimit(
      state.result.stderr,
      error.message,
      state.runtimeLimits.maxStderrBytes,
    );
  });
  if (proc.stdout) {
    readline
      .createInterface({ input: proc.stdout })
      .on("line", (line) =>
        processEventLine(
          line,
          state,
          emitUpdate,
          requestTermination,
          debugEventDiagnostics,
        ),
      );
  }
  if (proc.stderr) {
    proc.stderr.on("data", (data: Buffer) => {
      state.result.stderr = appendWithByteLimit(
        state.result.stderr,
        data,
        state.runtimeLimits.maxStderrBytes,
      );
    });
  }
}

async function finalizeResult(
  state: SubagentState,
  startedAt: number,
): Promise<RunSingleAgentResult> {
  state.result.durationMs = Date.now() - startedAt;
  clearGraceTimer(state);
  if (state.terminationPromise) await state.terminationPromise;
  if (state.spawnError) state.result.exitCode = 1;
  const outcome = getLatestOutcomeFromMessages(state.result.messages);
  const agentEndTimeoutExitCode = getAgentEndTimeoutExitCode(
    state.result,
    state.spawnError,
    outcome,
  );
  if (agentEndTimeoutExitCode !== undefined) {
    state.result.exitCode = agentEndTimeoutExitCode;
  }
  if (state.result.termination?.cancelReason === "agent_end_timeout") {
    state.result.stderr = state.result.stderr.replace(/^Terminated\r?\n/gm, "");
  }
  // Skip unresolved-error detection when complete succeeded: intermediate tool
  // errors (e.g. a linter exiting non-zero) are expected and already addressed.
  if (!outcome && detectMessageError(state.result.messages)) {
    state.result.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
  }
  if (state.wasAborted) {
    state.result.stderr = "";
    return { kind: "aborted", result: state.result };
  }
  const isSemanticallySuccessful =
    !state.spawnError &&
    state.result.exitCode === 0 &&
    (Boolean(outcome) ||
      (!state.result.errorMessage?.trim() &&
        !detectMessageError(state.result.messages)));
  if (isSemanticallySuccessful && outcome) {
    state.result.outcome = outcome;
  }
  return { kind: "completed", result: state.result };
}

/**
 * Rationale: Subagents run in isolated child processes to protect the parent's
 * context window and allow specialized system prompts/tools without polluting
 * the main conversation.
 *
 * Safety:
 * - Enforces a strict recursion limit (depth 2) via environment variables.
 * - Uses temporary prompt files to pass large system prompts without shell limits.
 * - Streams JSON events from the child to provide real-time UI updates to the parent.
 * - Implements aggressive process tree termination to prevent orphan processes.
 *
 * Side Effects: Spawns a child process and writes/deletes temporary files in `/tmp`.
 */
export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (
    results: RuntimeResult[],
    options?: { includeMessages?: boolean; recentMessages?: Message[] },
  ) => SubagentDetails,
  parentModel: ChildModelSettings | undefined,
  parentThinking: ThinkingLevel,
  debugEventDiagnostics = false,
  options: RunSingleAgentOptions = {},
): Promise<RunSingleAgentResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent)
    return {
      kind: "completed",
      result: errorForUnknownAgent(agentName, agents, task),
    };
  const runtimeLimits = getSubagentRuntimeLimits();
  const depth = getSubagentDepth();
  if (depth >= runtimeLimits.maxDepth) {
    return {
      kind: "completed",
      result: errorForDepthLimit(
        agentName,
        agent.source,
        task,
        depth,
        runtimeLimits.maxDepth,
      ),
    };
  }
  const requestedThinking = agent.thinking ?? parentThinking;
  const effectiveModel = resolveEffectiveChildModelSettings(agent, parentModel);
  const { level: thinking, warning: thinkingWarning } =
    effectiveModel.provider && effectiveModel.id
      ? resolveThinkingLevel(
          requestedThinking,
          effectiveModel.provider,
          effectiveModel.id,
        )
      : { level: requestedThinking };
  const modelDisplay = buildModelDisplay(effectiveModel, thinking);
  const resolvedSkillsPromise: Promise<{ args: string[] } | { error: string }> =
    agent.skills
      ? resolveAgentSkillArgs(defaultCwd, agent.skills)
      : Promise.resolve({ args: [] });
  const promptSetupPromise = beginPromptSetup(agent);
  const resolvedSkills = await resolvedSkillsPromise;
  if ("error" in resolvedSkills) {
    const promptSetup = await promptSetupPromise;
    await cleanupPromptSetupResult(promptSetup);
    return {
      kind: "completed",
      result: createErrorResult(
        agentName,
        agent.source,
        task,
        resolvedSkills.error,
        modelDisplay,
      ),
    };
  }
  const promptSetup = await promptSetupPromise;
  if ("error" in promptSetup) throw promptSetup.error;
  const startedAt = Date.now();
  const state: SubagentState = {
    result: initRuntimeResult(agentName, agent.source, task, modelDisplay),
    runtimeLimits,
    wasAborted: false,
  };
  if (thinkingWarning) state.result.thinkingWarning = thinkingWarning;
  const tmpPrompt = promptSetup.tmpPrompt;
  const samplingEnv = buildSamplingEnv(agent);
  try {
    const args = buildPiArgs(
      agent,
      task,
      effectiveModel,
      thinking,
      resolvedSkills,
      tmpPrompt,
    );
    if (samplingEnv) {
      args.push("--extension", SAMPLING_EXTENSION_PATH);
    }
    const invocation = getPiInvocation(args);
    const terminateOptions = {
      tree: true,
      platform: process.platform,
      processTreeDetached: process.platform !== "win32",
    };
    const childEnv = buildChildEnv(samplingEnv);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: defaultCwd,
      shell: invocation.command === "pi" && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      ...getProcessTreeSpawnOptions(terminateOptions.tree),
    });
    const processDone = waitForSubagentProcess(proc);
    const emitUpdate = makeEmitUpdate(state.result, onUpdate, makeDetails);
    const requestTermination = makeRequestTerminator(
      proc,
      terminateOptions,
      state,
    );
    setupChildProcess(
      proc,
      state,
      emitUpdate,
      requestTermination,
      debugEventDiagnostics,
    );
    const onAbort = setupAbortHandler(
      signal,
      state,
      () => clearGraceTimer(state),
      requestTermination,
    );
    const orchestratorPid = getValidatedOrchestratorPid(options);
    const sleepInhibitorPromise =
      orchestratorPid !== undefined
        ? acquireSubagentSleepInhibitor(
            orchestratorPid,
            options.acquireSleepInhibitor ?? acquireDefaultSleepInhibitor,
          )
        : Promise.resolve(undefined);
    try {
      state.result.exitCode = (await processDone) ?? 0;
      return await finalizeResult(state, startedAt);
    } finally {
      clearGraceTimer(state);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      void startSleepInhibitorRelease(sleepInhibitorPromise);
    }
  } finally {
    if (tmpPrompt) await cleanupTempPrompt(tmpPrompt);
  }
}
