/**
 * Manages subagent execution by spawning and orchestrating child `pi` processes.
 * Handles JSON-mode event streaming, resource tracking, and lifecycle management
 * including timeouts and termination signals.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import readline from "node:readline";
import { getModel, type Message } from "@earendil-works/pi-ai";
import type { AgentConfig, ThinkingLevel } from "./agents.js";
import { parseChildEventLine } from "./child-events.js";
import { makeToolPreview } from "./progress.js";
import { isToolCallPart } from "./progress-state.js";
import { appendSubagentResultContract } from "./prompt-contract.js";
import {
  getProcessTreeSpawnOptions,
  terminateChildProcess,
} from "./termination.js";
import type {
  OnUpdateCallback,
  SingleResult,
  StreamingProgress,
  SubagentDetails,
} from "./types.js";
import { getFinalOutput } from "./ui.js";
import {
  detectMessageError,
  getPiInvocation,
  getSubagentDepth,
  resolveAgentSkillArgs,
  subagentDepthEnv,
  truncateOutput,
  writePromptToTempFile,
} from "./utils.js";

const MAX_STDERR_BYTES = 10_000;
const AGENT_END_GRACE_MS = 250;

const MAX_SUBAGENT_DEPTH = 1;
export const TOOL_RESULT_FAILED_MESSAGE = "Subagent tool result failed.";

type RuntimeResult = SingleResult & { messages: Message[] };

interface SubagentState {
  result: RuntimeResult;
  spawnError?: Error;
  wasAborted: boolean;
  agentEndGraceTimer?: ReturnType<typeof setTimeout>;
  terminationPromise?: Promise<unknown>;
}

/**
 * Appends data to a string while ensuring the result does not exceed a maximum byte limit.
 * Used to prevent memory exhaustion when capturing child process stderr.
 */
function appendWithByteLimit(
  current: string,
  data: string,
  max: number,
): string {
  if (current.length >= max) return current;
  return current + data.slice(0, max - current.length);
}

/**
 * Attempts to resolve the context window token limit for a given message's model.
 * Rationale: Subagent usage reporting needs context window awareness to provide
 * meaningful "context full" indicators to the parent.
 */
function resolveContextWindowTokens(msg: Message): number | undefined {
  const m = msg as unknown as Record<string, unknown>;
  if (typeof m.provider !== "string" || typeof m.model !== "string") return;
  try {
    const { contextWindow } = getModel(m.provider as never, m.model as never);
    return Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  } catch {
    return;
  }
}

/**
 * Normalizes AbortSignal reasons into human-readable strings.
 */
function getAbortReason(signal: AbortSignal): string {
  const { reason } = signal;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "abort";
}

/**
 * Verifies if the agent produced any textual output or final response.
 * Precondition: Called after process exit to distinguish between clean completion
 * and silent failures where the process exited 0 but did nothing.
 */
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
 * Determines the exit code for processes terminated via the agent_end timeout.
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
 * Orchestrates the cleanup and exit code capture of a child process.
 * Safety: Implements a dual-timer strategy (idle and hard) to ensure streams
 * are destroyed and promises settled even if the process or its pipes hang.
 */
async function waitForSubagentProcess(
  proc: ChildProcess,
  idleMs = 100,
  hardMs = 5_000,
): Promise<number | null> {
  return new Promise((resolve) => {
    let exitCode: number | null = null;
    let exited = false;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;

    const done = () => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      resolve(exitCode);
    };

    const destroyStreams = () => {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    };

    const armIdleTimer = () => {
      if (!exited) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(destroyStreams, idleMs);
      idleTimer.unref?.();
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
      armIdleTimer();
      const hardTimer = setTimeout(destroyStreams, hardMs);
      hardTimer.unref?.();
    });
    proc.stdout?.on("data", armIdleTimer);
    proc.stderr?.on("data", armIdleTimer);
  });
}

function buildModelDisplay(
  parentModel: { provider: string; id: string } | undefined,
  thinking: ThinkingLevel,
): string | undefined {
  if (parentModel) {
    return `${parentModel.provider}/${parentModel.id}${thinking ? `:${thinking}` : ""}`;
  }
  return thinking ? `thinking:${thinking}` : undefined;
}

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
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: modelDisplay,
  };
}

function addMessageToResult(result: RuntimeResult, msg: Message): void {
  result.messages.push(msg);
  result.finalOutput = truncateOutput(getFinalOutput(result.messages));

  if (msg.role === "toolResult" && msg.isError) {
    result.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
  } else if (result.errorMessage === TOOL_RESULT_FAILED_MESSAGE) {
    result.errorMessage = undefined;
  }

  if (msg.role !== "assistant") return;
  result.usage.turns++;

  const { usage } = msg;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
    result.usage.contextWindowTokens =
      resolveContextWindowTokens(msg) ?? result.usage.contextWindowTokens;
  }

  if (!result.model && msg.model) result.model = msg.model;
  if (msg.stopReason) result.stopReason = msg.stopReason;
  if (msg.errorMessage) result.errorMessage = msg.errorMessage;
}

/**
 * Standardized error result generator.
 */
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
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
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
  model?: string,
): SingleResult {
  return createErrorResult(
    agentName,
    source,
    task,
    `Subagent nesting limit reached (depth ${depth}/${MAX_SUBAGENT_DEPTH}).`,
    model,
  );
}

async function cleanupTempPrompt(tmpPrompt: {
  dir: string;
  filePath: string;
}): Promise<void> {
  try {
    await fs.promises.unlink(tmpPrompt.filePath);
    await fs.promises.rmdir(tmpPrompt.dir);
  } catch {
    /* ignore */
  }
}

function findRecentMessagesAnchor(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg?.role === "assistant" &&
      msg.content.some(
        (c) => c.type === "text" && (c as { text?: string }).text?.trim(),
      )
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Derives current execution progress from accumulated messages.
 * Maps tool calls to UI-safe previews for real-time feedback.
 */
function deriveStreamingProgress(messages: Message[]): StreamingProgress {
  const toolCalls: { id: string; preview: string }[] = [];
  let lastToolPreview: string | undefined;
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
    }
  }
  return { activityText: lastToolPreview, toolCalls, lastToolPreview };
}

/**
 * Prevents leaking secrets in the CLI progress display.
 * Redacts values if the preview contains sensitive keywords.
 */
function sanitizeProgressPreview(preview: string, toolName: string): string {
  return /secret|token|password/i.test(preview) ? toolName : preview;
}

function makeEmitUpdate(
  result: RuntimeResult,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (
    results: RuntimeResult[],
    options?: { includeMessages?: boolean; recentMessages?: Message[] },
  ) => SubagentDetails,
): () => void {
  return () => {
    const msgs = result.messages;
    const anchorIdx = findRecentMessagesAnchor(msgs);
    const recentMessages =
      anchorIdx >= 0 ? msgs.slice(anchorIdx) : msgs.slice(-5);
    const progress = deriveStreamingProgress(msgs);
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
  state.agentEndGraceTimer = undefined;
}

function processEventLine(
  line: string,
  state: SubagentState,
  emitUpdate: () => void,
  requestTermination: (reason: string) => Promise<unknown>,
): void {
  const parseResult = parseChildEventLine(line);
  if (parseResult.kind !== "known") return;
  const { event } = parseResult;

  if (
    (event.type === "message_end" || event.type === "tool_result_end") &&
    event.message
  ) {
    addMessageToResult(state.result, event.message as Message);
    emitUpdate();
  }

  if (event.type !== "agent_end") return;

  if (state.result.messages.length === 0 && Array.isArray(event.messages)) {
    for (const msg of event.messages as Message[]) {
      addMessageToResult(state.result, msg);
    }
    emitUpdate();
  }

  if (state.agentEndGraceTimer || state.terminationPromise) return;
  state.agentEndGraceTimer = setTimeout(() => {
    state.agentEndGraceTimer = undefined;
    void requestTermination("agent_end_timeout");
  }, AGENT_END_GRACE_MS);
  state.agentEndGraceTimer.unref?.();
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

function buildPiArgs(
  agent: AgentConfig,
  task: string,
  parentModel: { provider: string; id: string } | undefined,
  thinking: ThinkingLevel,
  resolvedSkills: { args: string[] },
  tmpPrompt: { filePath: string } | null,
): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (parentModel) {
    args.push("--provider", parentModel.provider, "--model", parentModel.id);
  }
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
  emitUpdate: () => void,
  requestTermination: (reason: string) => Promise<unknown>,
): void {
  proc.once("error", (error) => {
    state.spawnError = error;
    state.result.stderr = appendWithByteLimit(
      state.result.stderr,
      error.message,
      MAX_STDERR_BYTES,
    );
  });
  if (proc.stdout) {
    readline
      .createInterface({ input: proc.stdout })
      .on("line", (line) =>
        processEventLine(line, state, emitUpdate, requestTermination),
      );
  }
  if (proc.stderr) {
    proc.stderr.on("data", (data) => {
      state.result.stderr = appendWithByteLimit(
        state.result.stderr,
        data.toString(),
        MAX_STDERR_BYTES,
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
  if (state.wasAborted) throw new Error("Subagent was aborted");
  return state.result;
}

/**
 * Executes a single subagent task.
 *
 * Rationale: Subagents run in isolated child processes to protect the parent's
 * context window and allow specialized system prompts/tools without polluting
 * the main conversation.
 *
 * Safety:
 * - Enforces a strict recursion limit (depth 1) via environment variables.
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
  parentModel: { provider: string; id: string } | undefined,
  parentThinking: ThinkingLevel,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) return errorForUnknownAgent(agentName, agents, task);

  const depth = getSubagentDepth();
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return errorForDepthLimit(agentName, agent.source, task, depth);
  }

  const thinking = agent.thinking ?? parentThinking;
  const modelDisplay = buildModelDisplay(parentModel, thinking);
  const resolvedSkills = agent.skills
    ? await resolveAgentSkillArgs(defaultCwd, agent.skills)
    : { args: [] };
  if ("error" in resolvedSkills) {
    return createErrorResult(
      agentName,
      agent.source,
      task,
      resolvedSkills.error,
      modelDisplay,
    );
  }

  const startedAt = Date.now();
  const state: SubagentState = {
    result: initRuntimeResult(agentName, agent.source, task, modelDisplay),
    wasAborted: false,
  };

  let tmpPrompt: { dir: string; filePath: string } | null = null;
  try {
    tmpPrompt = agent.systemPrompt.trim()
      ? await writePromptToTempFile(agent.name, agent.systemPrompt)
      : null;
    const args = buildPiArgs(
      agent,
      task,
      parentModel,
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
    setupChildProcess(proc, state, emitUpdate, requestTermination);

    const onAbort = setupAbortHandler(
      signal,
      state,
      () => clearGraceTimer(state),
      requestTermination,
    );
    try {
      state.result.exitCode = (await processDone) ?? 0;
      return await finalizeResult(state, startedAt);
    } finally {
      clearGraceTimer(state);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  } finally {
    if (tmpPrompt) await cleanupTempPrompt(tmpPrompt);
  }
}
