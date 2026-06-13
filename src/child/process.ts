/**
 * Manages subagent execution by spawning and orchestrating child `pi` processes.
 * Handles JSON-mode event streaming, resource tracking, and lifecycle management
 * including timeouts and termination signals.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import readline from "node:readline";
import {
  clampThinkingLevel,
  getModel,
  getSupportedThinkingLevels,
  type Message,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AgentConfig, ThinkingLevel } from "../agent/agents.js";
import { getFinalOutput } from "../output/ui.js";
import { makeToolPreview, renderToolActivity } from "../progress/progress.js";
import { SENSITIVE_PATTERN } from "../progress/progress-format.js";
import { isToolCallPart } from "../progress/progress-state.js";
import {
  type OnUpdateCallback,
  type SingleResult,
  type StreamingProgress,
  type SubagentDetails,
  TOOL_RESULT_FAILED_MESSAGE,
  type ToolActivity,
} from "../shared/types.js";
import {
  detectMessageError,
  findLastAssistantTextMessage,
  getPiInvocation,
  getSubagentDepth,
  getSubagentRuntimeLimits,
  resolveAgentSkillArgs,
  subagentDepthEnv,
  truncateOutput,
  writePromptToTempFile,
} from "../shared/utils.js";
import {
  type ChildEventParseResult,
  type ChildKnownEvent,
  parseChildEventLine,
  TOOL_EXECUTION_UPDATE_EVENT,
} from "./child-events.js";
import { appendSubagentResultContract } from "./prompt-contract.js";
import {
  acquireChildSleepInhibitor,
  getProcessTreeSpawnOptions,
  isFinitePid,
  makeHostSleepInhibitorAdapter,
  type SleepInhibitorHandle,
  terminateChildProcess,
} from "./termination.js";

export function resolveThinkingLevel(
  requested: ThinkingLevel,
  provider: string,
  modelId: string,
): { level: ThinkingLevel; warning?: string } {
  const model = getModel(provider as never, modelId as never);
  if (!model) return { level: requested };
  const mkWarning = (effective: ThinkingLevel) =>
    `Thinking level "${requested}" not supported by model "${provider}/${modelId}"; using "${effective}" instead`;
  if (model.reasoning === false) {
    return { level: "off", warning: mkWarning("off") };
  }
  if (!model.thinkingLevelMap) return { level: requested };
  const supported = getSupportedThinkingLevels(model);
  if (supported.length === 0) return { level: requested };
  const clamped = clampThinkingLevel(
    model,
    requested as ModelThinkingLevel,
  ) as ThinkingLevel;
  if (clamped === requested) return { level: requested };
  return { level: clamped, warning: mkWarning(clamped) };
}

type RuntimeLimits = ReturnType<typeof getSubagentRuntimeLimits>;
type RuntimeResult = SingleResult & { messages: Message[] };
type ChildModelSettings = {
  provider?: string | undefined;
  id?: string | undefined;
};
type SleepInhibitorAcquirer = (pid: number) => Promise<SleepInhibitorHandle>;

type RunSingleAgentOptions = {
  acquireSleepInhibitor?: SleepInhibitorAcquirer;
  getOrchestratorPid?: () => unknown;
};

export class SubagentAbortError extends Error {
  readonly result: SingleResult;
  constructor(result: SingleResult) {
    super("Subagent was aborted");
    this.name = "SubagentAbortError";
    this.result = result;
  }
}

type TempPrompt = { dir: string; filePath: string };

type PromptSetupResult = { tmpPrompt: TempPrompt | null } | { error: unknown };

interface SubagentState {
  result: RuntimeResult;
  runtimeLimits: RuntimeLimits;
  spawnError?: Error;
  wasAborted: boolean;
  agentEndGraceTimer?: ReturnType<typeof setTimeout>;
  terminationPromise?: Promise<unknown>;
}

function appendWithByteLimit(
  current: string,
  data: string | Buffer,
  max: number,
): string {
  const currentBytes = Buffer.from(current, "utf-8");
  if (currentBytes.length >= max) return current;
  const incomingBytes = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data, "utf-8");
  const combined = Buffer.concat([currentBytes, incomingBytes]);
  if (combined.length <= max) return combined.toString("utf-8");
  return truncateValidUtf8(combined, max);
}

function truncateValidUtf8(buffer: Buffer, max: number): string {
  let end = Math.min(max, buffer.length);
  while (end > 0) {
    const candidate = buffer.subarray(0, end).toString("utf-8");
    if (!candidate.endsWith("�")) return candidate;
    end -= 1;
  }
  return "";
}

/**
 * Rationale: Subagent usage reporting needs context window awareness to provide
 * meaningful "context full" indicators to the parent.
 */
function resolveContextWindowTokens(msg: Message): number | undefined {
  const m = msg as unknown as Record<string, unknown>;
  if (typeof m["provider"] !== "string" || typeof m["model"] !== "string")
    return;
  try {
    const contextWindow = getModel(
      m["provider"] as never,
      m["model"] as never,
    )?.contextWindow;
    return Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  } catch {
    /* model lookup failures return undefined to skip context window tracking */
    return;
  }
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

function hasCompletedAgentOutput(result: RuntimeResult): boolean {
  if (result.finalOutput.trim()) return true;
  return result.messages.some(
    (msg) =>
      msg.role === "assistant" &&
      msg.content.some(
        (part) => part.type === "text" && Boolean(part.text?.trim()),
      ),
  );
}

/**
 * Rationale: `pi` processes in JSON mode might hang after finishing their task;
 * we force-kill them after a grace period and treat it as success (0) if they
 * actually produced output.
 */
function getAgentEndTimeoutExitCode(
  result: RuntimeResult,
  spawnError: Error | undefined,
): number | undefined {
  if (result.termination?.cancelReason !== "agent_end_timeout") return;
  if (spawnError) return;
  if (result.stopReason === "error" || result.stopReason === "aborted") return;
  if (result.errorMessage?.trim()) return;
  return hasCompletedAgentOutput(result) ? 0 : 1;
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

function buildModelDisplay(
  effectiveModel: ChildModelSettings,
  thinking: ThinkingLevel,
): string | undefined {
  const modelText =
    effectiveModel.provider && effectiveModel.id
      ? `${effectiveModel.provider}/${effectiveModel.id}`
      : (effectiveModel.provider ?? effectiveModel.id);
  if (modelText) return `${modelText}${thinking ? `:${thinking}` : ""}`;
  return thinking ? `thinking:${thinking}` : undefined;
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

function initRuntimeResult(
  agentName: string,
  source: "user" | "project" | "unknown",
  task: string,
  modelDisplay: string | undefined,
): RuntimeResult {
  return {
    agent: agentName,
    agentSource: source,
    task,
    exitCode: 0,
    finalOutput: "",
    messages: [],
    stderr: "",
    usage: { ...EMPTY_USAGE },
    model: modelDisplay,
  };
}

function accumulateUsage(result: RuntimeResult, msg: Message): void {
  if (msg.role !== "assistant") return;
  result.usage.turns++;
  const { usage } = msg;
  if (!usage) return;
  result.usage.input += usage.input || 0;
  result.usage.output += usage.output || 0;
  result.usage.cacheRead += usage.cacheRead || 0;
  result.usage.cacheWrite += usage.cacheWrite || 0;
  result.usage.cost += usage.cost?.total || 0;
  result.usage.contextTokens = usage.totalTokens || 0;
  const ctxWindowTokens = resolveContextWindowTokens(msg);
  if (ctxWindowTokens !== undefined)
    result.usage.contextWindowTokens = ctxWindowTokens;
}

function addMessageToResult(result: RuntimeResult, msg: Message): void {
  result.messages.push(msg);
  result.finalOutput = truncateOutput(getFinalOutput(result.messages));
  if (msg.role === "toolResult" && msg.isError) {
    result.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
  } else if (result.errorMessage === TOOL_RESULT_FAILED_MESSAGE) {
    delete result.errorMessage;
  }
  if (msg.role === "assistant") {
    accumulateUsage(result, msg);
    if (!result.model && msg.model) result.model = msg.model;
    if (msg.stopReason) result.stopReason = msg.stopReason;
    if (msg.errorMessage) result.errorMessage = msg.errorMessage;
  }
}

function createErrorResult(
  agent: string,
  source: "user" | "project" | "unknown",
  task: string,
  error: string,
  model?: string,
): SingleResult {
  return {
    agent,
    agentSource: source,
    task,
    exitCode: 1,
    finalOutput: "",
    stderr: error,
    usage: { ...EMPTY_USAGE },
    model,
  };
}

function errorForUnknownAgent(
  agentName: string,
  agents: AgentConfig[],
  task: string,
): SingleResult {
  const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
  return createErrorResult(
    agentName,
    "unknown",
    task,
    `Unknown agent: "${agentName}". Available agents: ${available}.`,
  );
}

function errorForDepthLimit(
  agentName: string,
  source: "user" | "project" | "unknown",
  task: string,
  depth: number,
  maxDepth: number,
  model?: string,
): SingleResult {
  return createErrorResult(
    agentName,
    source,
    task,
    `Subagent nesting limit reached (depth ${depth}/${maxDepth}).`,
    model,
  );
}

async function cleanupTempPrompt(tmpPrompt: TempPrompt): Promise<void> {
  try {
    await fs.promises.unlink(tmpPrompt.filePath);
    await fs.promises.rmdir(tmpPrompt.dir);
  } catch {
    /* temp file cleanup failures are non-fatal; OS will clean up eventually */
  }
}

function beginPromptSetup(agent: AgentConfig): Promise<PromptSetupResult> {
  if (!agent.systemPrompt.trim()) return Promise.resolve({ tmpPrompt: null });
  return writePromptToTempFile(agent.name, agent.systemPrompt).then(
    (tmpPrompt) => ({ tmpPrompt }),
    (error: unknown) => ({ error }),
  );
}

async function cleanupPromptSetupResult(
  setup: PromptSetupResult,
): Promise<void> {
  if ("tmpPrompt" in setup && setup.tmpPrompt) {
    await cleanupTempPrompt(setup.tmpPrompt);
  }
}

function findRecentMessagesAnchor(messages: Message[]): number {
  return findLastAssistantTextMessage(messages);
}

function deriveStreamingProgress(messages: Message[]): StreamingProgress {
  const toolCalls: { id: string; preview: string }[] = [];
  let lastToolPreview: string | undefined;
  let activeToolActivity: ToolActivity | undefined;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!isToolCallPart(part)) continue;
      const preview = sanitizeProgressPreview(
        makeToolPreview(part.name, part.arguments),
        part.name,
      );
      toolCalls.push({ id: part.id, preview });
      lastToolPreview = preview;
      activeToolActivity = { toolName: part.name, inputSummary: preview };
    }
  }
  const activityText = renderToolActivity(activeToolActivity);
  return {
    activeToolActivity,
    activityText,
    toolCalls,
    lastToolPreview,
  };
}

function sanitizeProgressPreview(preview: string, toolName: string): string {
  return SENSITIVE_PATTERN.test(preview) ? toolName : preview;
}

/**
 * Merge incoming tool activity with existing progress activity.
 * When tool names match, prefer richer inputSummary from incoming.
 * Otherwise, replace entirely with incoming activity.
 */
function mergeToolActivity(
  existing: ToolActivity | undefined,
  incoming: ToolActivity,
): ToolActivity {
  if (existing && existing.toolName === incoming.toolName) {
    const incomingSummary = incoming.inputSummary;
    const preferIncoming =
      incomingSummary && incomingSummary !== incoming.toolName;
    return {
      ...existing,
      inputSummary: preferIncoming ? incomingSummary : existing.inputSummary,
      instanceName: incoming.instanceName ?? existing.instanceName,
      child: incoming.child ?? existing.child,
    };
  }
  return incoming;
}

/**
 * Apply tool activity and result completion updates to progress state.
 * Handles merging of child events with parent activity tree.
 */
function applyActivityUpdates(
  progress: StreamingProgress,
  options: { toolActivity?: ToolActivity; toolResultCompleted?: boolean },
  previousActivity?: ToolActivity,
): void {
  // Preserve stored activity tree for tool-result completion signals
  // so the parent retains nested context until newer activity arrives
  if (options.toolResultCompleted && previousActivity) {
    progress.activeToolActivity = previousActivity;
    const renderedText = renderToolActivity(previousActivity);
    if (renderedText !== undefined) progress.activityText = renderedText;
    else delete progress.activityText;
  }
  // Handle parsed tool activity from child events
  // Merge with parent activity if this is a nested update
  if (options.toolActivity) {
    progress.activeToolActivity = mergeToolActivity(
      progress.activeToolActivity,
      options.toolActivity,
    );
    const renderedActivity = renderToolActivity(progress.activeToolActivity);
    if (renderedActivity !== undefined)
      progress.activityText = renderedActivity;
    else delete progress.activityText;
  }
  if (options.toolResultCompleted) {
    progress.toolResultCompleted = true;
  }
}

export function makeEmitUpdate(
  result: RuntimeResult,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (
    results: RuntimeResult[],
    options?: { includeMessages?: boolean; recentMessages?: Message[] },
  ) => SubagentDetails,
): (options?: {
  toolActivity?: ToolActivity;
  toolResultCompleted?: boolean;
}) => void {
  return (options) => {
    const msgs = result.messages;
    const anchorIdx = findRecentMessagesAnchor(msgs);
    const recentMessages =
      anchorIdx >= 0 ? msgs.slice(anchorIdx) : msgs.slice(-5);
    const progress = deriveStreamingProgress(msgs);
    if (options) {
      applyActivityUpdates(
        progress,
        options,
        result.progress?.activeToolActivity,
      );
    }
    result.progress = progress;
    onUpdate?.({
      content: [
        { type: "text", text: progress.activityText ?? "(running...)" },
      ],
      details: makeDetails([result], {
        includeMessages: true,
        recentMessages,
      }),
    });
  };
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
  emitUpdate: (options?: {
    toolActivity?: ToolActivity;
    toolResultCompleted?: boolean;
  }) => void,
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
  emitUpdate: (options?: {
    toolActivity?: ToolActivity;
    toolResultCompleted?: boolean;
  }) => void,
): void {
  if (event.type !== TOOL_EXECUTION_UPDATE_EVENT) return;
  emitUpdate({ toolActivity: event.toolActivity });
}

function handleAgentEndEvent(
  event: ChildKnownEvent,
  state: SubagentState,
  emitUpdate: (options?: {
    toolActivity?: ToolActivity;
    toolResultCompleted?: boolean;
  }) => void,
  requestTermination: (reason: string) => Promise<unknown>,
): void {
  if (event.type !== "agent_end") return;
  if (state.result.messages.length === 0 && Array.isArray(event.messages)) {
    for (const msg of event.messages as Message[]) {
      addMessageToResult(state.result, msg);
    }
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
  emitUpdate: (options?: {
    toolActivity?: ToolActivity;
    toolResultCompleted?: boolean;
  }) => void,
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

function resolveEffectiveChildModelSettings(
  agent: AgentConfig,
  parentModel: ChildModelSettings | undefined,
): ChildModelSettings {
  return {
    provider: agent.provider ?? parentModel?.provider,
    id:
      agent.model ??
      (agent.provider === undefined ? parentModel?.id : undefined),
  };
}

function buildPiArgs(
  agent: AgentConfig,
  task: string,
  effectiveModel: ChildModelSettings,
  thinking: ThinkingLevel,
  resolvedSkills: { args: string[] },
  tmpPrompt: { filePath: string } | null,
): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (effectiveModel.provider && effectiveModel.id)
    args.push("--provider", effectiveModel.provider);
  if (effectiveModel.id) args.push("--model", effectiveModel.id);
  args.push("--thinking", thinking);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
  if (agent.skills) args.push("--no-skills", ...resolvedSkills.args);
  if (tmpPrompt) {
    args.push("--append-system-prompt", tmpPrompt.filePath);
  }
  const taskPrompt = task
    ? `Task: ${task}`
    : "Run according to your system prompt. If no explicit task was provided, use the default context described there.";
  args.push(appendSubagentResultContract(taskPrompt));
  return args;
}

function setupChildProcess(
  proc: ChildProcess,
  state: SubagentState,
  emitUpdate: (options?: {
    toolActivity?: ToolActivity;
    toolResultCompleted?: boolean;
  }) => void,
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
): Promise<SingleResult> {
  state.result.durationMs = Date.now() - startedAt;
  clearGraceTimer(state);
  if (state.terminationPromise) await state.terminationPromise;
  if (state.spawnError) state.result.exitCode = 1;
  if (detectMessageError(state.result.messages)) {
    state.result.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
  }
  const agentEndTimeoutExitCode = getAgentEndTimeoutExitCode(
    state.result,
    state.spawnError,
  );
  if (agentEndTimeoutExitCode !== undefined) {
    state.result.exitCode = agentEndTimeoutExitCode;
  }
  if (state.wasAborted) {
    state.result.stderr = "";
    throw new SubagentAbortError(state.result);
  }
  return state.result;
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
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) return errorForUnknownAgent(agentName, agents, task);
  const runtimeLimits = getSubagentRuntimeLimits();
  const depth = getSubagentDepth();
  if (depth >= runtimeLimits.maxDepth) {
    return errorForDepthLimit(
      agentName,
      agent.source,
      task,
      depth,
      runtimeLimits.maxDepth,
    );
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
    return createErrorResult(
      agentName,
      agent.source,
      task,
      resolvedSkills.error,
      modelDisplay,
    );
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
  try {
    const args = buildPiArgs(
      agent,
      task,
      effectiveModel,
      thinking,
      resolvedSkills,
      tmpPrompt,
    );
    const invocation = getPiInvocation(args);
    const terminateOptions = {
      tree: true,
      platform: process.platform,
      processTreeDetached: process.platform !== "win32",
    };
    const proc = spawn(invocation.command, invocation.args, {
      cwd: defaultCwd,
      shell: invocation.command === "pi" && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...subagentDepthEnv() },
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
