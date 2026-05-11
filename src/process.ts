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

type RuntimeResult = SingleResult & { messages: Message[] };

const MAX_SUBAGENT_DEPTH = 1;
export const TOOL_RESULT_FAILED_MESSAGE = "Subagent tool result failed.";

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

type AssistantMessageMetadata = Message & {
  provider?: unknown;
  model?: unknown;
};

/**
 * Attempts to resolve the context window token limit for a given message's model.
 * Rationale: Subagent usage reporting needs context window awareness to provide
 * meaningful "context full" indicators to the parent.
 */
function resolveContextWindowTokens(msg: Message): number | undefined {
  const { provider, model } = msg as AssistantMessageMetadata;
  if (typeof provider !== "string" || typeof model !== "string") return;
  try {
    const resolved = getModel(provider as never, model as never);
    const contextWindow = resolved.contextWindow;
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
  const reason = signal.reason;
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
    let idleTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
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
      hardTimer = setTimeout(destroyStreams, hardMs);
      hardTimer.unref?.();
    });
    proc.stdout?.on("data", armIdleTimer);
    proc.stderr?.on("data", armIdleTimer);
  });
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
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return createErrorResult(
      agentName,
      "unknown",
      task,
      `Unknown agent: "${agentName}". Available agents: ${available}.`,
    );
  }
  const depth = getSubagentDepth();
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return createErrorResult(
      agentName,
      agent.source,
      task,
      `Subagent nesting limit reached (depth ${depth}/${MAX_SUBAGENT_DEPTH}).`,
    );
  }
  const thinking = agent.thinking ?? parentThinking;
  const modelDisplay = parentModel
    ? `${parentModel.provider}/${parentModel.id}${thinking ? `:${thinking}` : ""}`
    : thinking
      ? `thinking:${thinking}`
      : undefined;
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
  const currentResult: RuntimeResult = {
    agent: agentName,
    agentSource: agent.source,
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
  const nextUpdateText = () => {
    const progress = deriveStreamingProgress(currentResult.messages);
    currentResult.progress = progress;
    return progress.activityText ?? "(running...)";
  };
  const emitUpdate = () => {
    const msgs = currentResult.messages;
    let anchorIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (
        m?.role === "assistant" &&
        m.content.some(
          (c) => c.type === "text" && (c as { text?: string }).text?.trim(),
        )
      ) {
        anchorIdx = i;
        break;
      }
    }
    const recentMessages =
      anchorIdx >= 0 ? msgs.slice(anchorIdx) : msgs.slice(-5);
    const activityText = nextUpdateText();
    onUpdate?.({
      content: [{ type: "text", text: activityText }],
      details: makeDetails([currentResult], {
        includeMessages: true,
        recentMessages,
      }),
    });
  };
  let tmpPrompt: { dir: string; filePath: string } | null = null;
  try {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (parentModel)
      args.push("--provider", parentModel.provider, "--model", parentModel.id);
    args.push("--thinking", thinking);
    if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
    if (agent.skills) args.push("--no-skills", ...resolvedSkills.args);
    if (agent.systemPrompt.trim()) {
      tmpPrompt = await writePromptToTempFile(agent.name, agent.systemPrompt);
      args.push("--append-system-prompt", tmpPrompt.filePath);
    }
    const taskPrompt = task
      ? `Task: ${task}`
      : "Run according to your system prompt. If no explicit task was provided, use the default context described there.";
    args.push(appendSubagentResultContract(taskPrompt));
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
    let spawnError: Error | undefined;
    proc.once("error", (error) => {
      spawnError = error;
      currentResult.stderr = appendWithByteLimit(
        currentResult.stderr,
        error.message,
        MAX_STDERR_BYTES,
      );
    });
    let wasAborted = false;
    let terminationPromise: Promise<unknown> | undefined;
    let agentEndGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const clearAgentEndGraceTimer = () => {
      if (!agentEndGraceTimer) return;
      clearTimeout(agentEndGraceTimer);
      agentEndGraceTimer = undefined;
    };
    const requestTermination = (reason: string) => {
      terminationPromise ??= terminateChildProcess(proc, {
        ...terminateOptions,
        reason,
      }).then((metadata) => {
        currentResult.termination = metadata;
      });
      return terminationPromise;
    };
    const addMessage = (msg: Message) => {
      currentResult.messages.push(msg);
      currentResult.finalOutput = truncateOutput(
        getFinalOutput(currentResult.messages),
      );
      if (msg.role === "toolResult" && msg.isError) {
        currentResult.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
      } else if (currentResult.errorMessage === TOOL_RESULT_FAILED_MESSAGE) {
        currentResult.errorMessage = undefined;
      }
      if (msg.role === "assistant") {
        currentResult.usage.turns++;
        const usage = msg.usage;
        if (usage) {
          currentResult.usage.input += usage.input || 0;
          currentResult.usage.output += usage.output || 0;
          currentResult.usage.cacheRead += usage.cacheRead || 0;
          currentResult.usage.cacheWrite += usage.cacheWrite || 0;
          currentResult.usage.cost += usage.cost?.total || 0;
          currentResult.usage.contextTokens = usage.totalTokens || 0;
          currentResult.usage.contextWindowTokens =
            resolveContextWindowTokens(msg) ??
            currentResult.usage.contextWindowTokens;
        }
        if (!currentResult.model && msg.model) currentResult.model = msg.model;
        if (msg.stopReason) currentResult.stopReason = msg.stopReason;
        if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
      }
    };
    const processLine = (line: string) => {
      const parseResult = parseChildEventLine(line);
      if (parseResult.kind === "invalid") return;
      if (parseResult.kind === "known") {
        const event = parseResult.event;
        if (
          (event.type === "message_end" || event.type === "tool_result_end") &&
          event.message
        ) {
          addMessage(event.message as Message);
          emitUpdate();
        }
        if (event.type === "agent_end") {
          if (
            currentResult.messages.length === 0 &&
            Array.isArray(event.messages)
          ) {
            for (const msg of event.messages as Message[]) addMessage(msg);
            emitUpdate();
          }
          if (!agentEndGraceTimer && !terminationPromise) {
            agentEndGraceTimer = setTimeout(() => {
              agentEndGraceTimer = undefined;
              void requestTermination("agent_end_timeout");
            }, AGENT_END_GRACE_MS);
            agentEndGraceTimer.unref?.();
          }
        }
      }
    };
    if (proc.stdout) {
      readline.createInterface({ input: proc.stdout }).on("line", processLine);
    }
    if (proc.stderr) {
      proc.stderr.on("data", (data) => {
        currentResult.stderr = appendWithByteLimit(
          currentResult.stderr,
          data.toString(),
          MAX_STDERR_BYTES,
        );
      });
    }
    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => {
        wasAborted = true;
        clearAgentEndGraceTimer();
        void requestTermination(getAbortReason(signal));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      currentResult.exitCode = (await processDone) ?? 0;
      currentResult.durationMs = Date.now() - startedAt;
      clearAgentEndGraceTimer();
      if (terminationPromise) await terminationPromise;
      if (spawnError) currentResult.exitCode = 1;
      if (detectMessageError(currentResult.messages)) {
        currentResult.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
      }
      const agentEndTimeoutExitCode = getAgentEndTimeoutExitCode(
        currentResult,
        spawnError,
      );
      if (agentEndTimeoutExitCode !== undefined) {
        currentResult.exitCode = agentEndTimeoutExitCode;
      }
      if (wasAborted) throw new Error("Subagent was aborted");
      return currentResult;
    } finally {
      clearAgentEndGraceTimer();
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  } finally {
    if (tmpPrompt) {
      try {
        await fs.promises.unlink(tmpPrompt.filePath);
        await fs.promises.rmdir(tmpPrompt.dir);
      } catch {
        /* ignore */
      }
    }
  }
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

