import { type Message, StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  type AgentConfig,
  type AgentScope,
  discoverAgents,
  type ThinkingLevel,
} from "./agents.js";
import { runSingleAgent, TOOL_RESULT_FAILED_MESSAGE } from "./process.js";
import {
  cancelProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  patchProgressState,
} from "./progress.js";
import { type RunJob, registerRunJob, removeRunJob } from "./run-registry.js";
import {
  formatSubagentResultForParent,
  summarizeFeedbackUiFinalOutput,
} from "./summary.js";
import type {
  OnUpdateCallback,
  SingleResult,
  SubagentDetails,
} from "./types.js";
import { renderSubagentResult, type SubagentTheme } from "./ui.js";
import { detectMessageError } from "./utils.js";

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "both" (user + project-local agents).',
  default: "both",
});

export const SubagentParams = Type.Object({
  agent: Type.String({
    description: "Name of the agent to invoke",
  }),
  task: Type.Optional(
    Type.String({
      description: "Task to delegate. Optional for agents with defaults.",
    }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  debug: Type.Optional(
    Type.Boolean({
      description:
        "Internal debug option. Include full child messages in result details.",
      default: false,
    }),
  ),
});

export type SubagentToolResult = {
  content: { type: "text"; text: string }[];
  details: SubagentDetails;
};

type DetailsOptions = { includeMessages?: boolean; recentMessages?: Message[] };
type DetailsBuilder = (
  results: SingleResult[],
  options?: DetailsOptions,
) => SubagentDetails;
type MergedRunSignal = { signal: AbortSignal; cleanup: () => void };

function createDetailsBuilder(
  agentScope: AgentScope,
  projectAgentsDir: string | null,
  includeDebugMessages: boolean,
): DetailsBuilder {
  return (results, options) => ({
    mode: "single",
    agentScope,
    projectAgentsDir,
    results: results.map((result) =>
      sanitizeResultDetails(result, includeDebugMessages, options),
    ),
  });
}

function sanitizeResultDetails(
  result: SingleResult,
  includeDebugMessages: boolean,
  options: DetailsOptions | undefined,
): SingleResult {
  const { messages, termination, stderr, ...rest } = result;
  const includeMessages =
    includeDebugMessages && (options?.includeMessages ?? true);
  const progress = result.progress
    ? {
        ...result.progress,
        toolCalls: result.progress.toolCalls.map((toolCall) => ({
          ...toolCall,
        })),
      }
    : undefined;
  const base = {
    ...rest,
    ...(progress ? { progress } : {}),
    usage: { ...result.usage },
    stderr: includeDebugMessages ? stderr : "",
  };
  if (!includeMessages) return base;
  return {
    ...base,
    messages: options?.recentMessages
      ? [...options.recentMessages]
      : messages
        ? [...messages]
        : undefined,
    ...(includeDebugMessages && termination
      ? { termination: { ...termination } }
      : {}),
  };
}

function hasSubagentFailed(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    Boolean(result.errorMessage?.trim()) ||
    detectMessageError(result.messages ?? [])
  );
}

function createSubagentError(result: SingleResult): Error {
  const formatted = formatSubagentResultForParent(result);
  const errorMessage = result.errorMessage?.trim();
  const preferErrorMessage =
    errorMessage && errorMessage !== TOOL_RESULT_FAILED_MESSAGE;
  const errorMsg =
    (preferErrorMessage ? errorMessage : undefined) ||
    formatted ||
    result.stderr ||
    errorMessage ||
    result.finalOutput ||
    "(no output)";
  return new Error(`Agent ${result.stopReason || "failed"}: ${errorMsg}`);
}

export function renderSubagentResultMessage(
  message: { content?: unknown; details?: unknown },
  theme: SubagentTheme,
) {
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content)
        ? (message.content as { type: string; text?: string }[])
        : [];
  const details = message.details as SubagentDetails | undefined;
  const bodyOverride = content.find((item) => item.type === "text")?.text;
  return renderSubagentResult(
    { content, details },
    theme,
    undefined,
    bodyOverride,
  );
}

export function sanitizeDetailsForDisplay(
  details: SubagentDetails,
  includeMessages = false,
): SubagentDetails {
  return {
    ...details,
    results: details.results.map(({ messages, termination, ...result }) => ({
      ...result,
      stderr: includeMessages ? result.stderr : "",
      ...(includeMessages ? { messages, termination } : {}),
    })),
  };
}

export function patchProgressFromDetails(
  requestId: string,
  details: SubagentDetails,
  seenToolCallIds: Set<string>,
): void {
  const latestResult = details.results[0];
  const { newToolCallIds, lastToolPreview } = extractProgressFromDetails(
    details,
    seenToolCallIds,
  );
  const current = getProgressState(requestId);
  if (!current) return;
  patchProgressState(requestId, {
    toolCount: current.toolCount + newToolCallIds.length,
    ...(lastToolPreview ? { lastToolPreview } : {}),
    ...(latestResult?.usage
      ? {
          inputTokens: latestResult.usage.input,
          outputTokens: latestResult.usage.output,
          contextTokens: latestResult.usage.contextTokens,
          contextWindowTokens: latestResult.usage.contextWindowTokens,
        }
      : {}),
  });
}

export function getSubagentText(result: SubagentToolResult): string {
  return (result.content[0] as { text?: string })?.text ?? "";
}

export function getResultDisplayText(result: SubagentToolResult): string {
  return result.details.results[0]?.finalOutput ?? getSubagentText(result);
}

export function getFeedbackSummaryText(result: SubagentToolResult): string {
  const rawFinalOutput = result.details.results[0]?.finalOutput;
  if (rawFinalOutput?.trim())
    return summarizeFeedbackUiFinalOutput(rawFinalOutput);
  return getSubagentText(result).trim() || "(no output)";
}

export function parseRunArgs(
  args: string,
): { agentName: string; task: string; debug: boolean } | undefined {
  const input = args.trim();
  if (!input) return undefined;
  const debug = input.startsWith("--debug ");
  const command = debug ? input.slice("--debug ".length).trim() : input;
  if (!command) return undefined;
  const firstSpace = command.indexOf(" ");
  if (firstSpace === -1) return { agentName: command, task: "", debug };
  return {
    agentName: command.slice(0, firstSpace),
    task: command.slice(firstSpace + 1).trim(),
    debug,
  };
}

function createMergedRunSignal(
  hostSignal: AbortSignal | undefined,
  jobSignal: AbortSignal,
): MergedRunSignal {
  const relay = new AbortController();
  const abortFromHost = () => relay.abort(hostSignal?.reason);
  const abortFromJob = () => relay.abort(jobSignal.reason);
  if (hostSignal?.aborted) abortFromHost();
  else {
    hostSignal?.addEventListener("abort", abortFromHost, { once: true });
    if (hostSignal?.aborted) abortFromHost();
  }
  if (jobSignal.aborted) abortFromJob();
  else {
    jobSignal.addEventListener("abort", abortFromJob, { once: true });
    if (jobSignal.aborted) abortFromJob();
  }
  return {
    signal: relay.signal,
    cleanup: () => {
      hostSignal?.removeEventListener("abort", abortFromHost);
      jobSignal.removeEventListener("abort", abortFromJob);
    },
  };
}

function createProgressRenderRequester(
  ctx: ExtensionContext,
  requestId: string,
): () => void {
  const progressRenderKey = `subagent-progress:${requestId}`;
  return () => {
    ctx.ui?.setStatus?.(progressRenderKey, `${Date.now()}`);
    ctx.ui?.setStatus?.(progressRenderKey, undefined);
  };
}

function cancelStartedJob(
  job: RunJob,
  mergedSignal: MergedRunSignal,
  reason: string,
): void {
  cancelProgressState(job.requestId, reason);
  mergedSignal.cleanup();
  removeRunJob(job.requestId);
}

async function runSubagentWorker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  debug: boolean,
  parentModel: { provider: string; id: string } | undefined,
  parentThinking: ThinkingLevel,
  makeDetails: DetailsBuilder,
  requestId: string,
  job: RunJob,
  mergedSignal: MergedRunSignal,
): Promise<void> {
  const seenToolCallIds = new Set<string>();
  const requestProgressRender = createProgressRenderRequester(ctx, requestId);
  const onUpdate: OnUpdateCallback = (result) => {
    patchProgressFromDetails(requestId, result.details, seenToolCallIds);
    requestProgressRender();
  };
  try {
    const result = await runSingleAgent(
      ctx.cwd,
      agents,
      agentName,
      task,
      mergedSignal.signal,
      onUpdate,
      makeDetails,
      parentModel,
      parentThinking,
    );
    if (hasSubagentFailed(result)) {
      if (mergedSignal.signal.aborted) {
        cancelProgressState(requestId, job.cancelReason ?? "Aborted");
      } else {
        const error = createSubagentError(result);
        failProgressState(requestId, error.message);
        ctx.ui?.notify(error.message, "error");
        pi.sendMessage({
          customType: "subagent-result",
          content: formatSubagentResultForParent(result) || "(failed)",
          display: true,
          details: sanitizeDetailsForDisplay(makeDetails([result]), debug),
        });
      }
    } else {
      const toolResult: SubagentToolResult = {
        content: [
          {
            type: "text" as const,
            text: formatSubagentResultForParent(result) || "(no output)",
          },
        ],
        details: makeDetails([result]),
      };
      finalizeProgressState(requestId, getFeedbackSummaryText(toolResult));
      pi.sendMessage({
        customType: "subagent-result",
        content: getResultDisplayText(toolResult),
        display: true,
        details: sanitizeDetailsForDisplay(toolResult.details, debug),
      });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (mergedSignal.signal.aborted) {
      cancelProgressState(requestId, job.cancelReason ?? errorMsg);
    } else {
      failProgressState(requestId, errorMsg);
      ctx.ui?.notify(errorMsg, "error");
      pi.sendMessage({
        customType: "subagent-result",
        content: errorMsg,
        display: true,
        details: sanitizeDetailsForDisplay(makeDetails([]), debug),
      });
    }
  } finally {
    requestProgressRender();
    mergedSignal.cleanup();
    removeRunJob(requestId);
  }
}

type StartJobResult =
  | { kind: "started"; requestId: string; makeDetails: DetailsBuilder }
  | { kind: "cancelled"; requestId: string; makeDetails: DetailsBuilder }
  | { kind: "not_found"; makeDetails: DetailsBuilder };

export async function startSubagentJob(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Static<typeof SubagentParams>,
  hostSignal: AbortSignal | undefined,
): Promise<StartJobResult> {
  const agentScope: AgentScope = params.agentScope ?? "both";
  const discovery = discoverAgents(ctx.cwd, agentScope);
  const agents = discovery.agents;
  const debug = params.debug === true;
  const makeDetails = createDetailsBuilder(
    agentScope,
    discovery.projectAgentsDir,
    debug,
  );
  const requested = agents.find((a) => a.name === params.agent);
  if (!requested) return { kind: "not_found", makeDetails };
  const parentModel = ctx.model
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : undefined;
  const parentThinking = pi.getThinkingLevel() as ThinkingLevel;
  const task = params.task?.trim() ?? "";
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  const job: RunJob = registerRunJob({
    requestId,
    agentName: params.agent,
    controller,
    startedAt: Date.now(),
  });
  const mergedSignal = createMergedRunSignal(hostSignal, job.controller.signal);
  createProgressState(requestId, params.agent, task);
  pi.sendMessage({
    customType: "subagent-progress",
    content: "",
    display: true,
    details: { requestId },
  });
  const requestProgressRender = createProgressRenderRequester(ctx, requestId);
  if ((agentScope === "project" || agentScope === "both") && ctx.hasUI) {
    if (requested.source === "project") {
      const dir = discovery.projectAgentsDir ?? "(unknown)";
      let ok: boolean;
      try {
        ok = await ctx.ui.confirm(
          "Run project-local agent?",
          `Agent: ${requested.name}
Source: ${dir}

Project agents are repo-controlled. Only continue for trusted repositories.`,
        );
      } catch (e) {
        cancelStartedJob(job, mergedSignal, "Confirm failed");
        throw e;
      }
      if (!ok) {
        cancelStartedJob(
          job,
          mergedSignal,
          "Canceled: project-local agent not approved.",
        );
        requestProgressRender();
        return { kind: "cancelled", requestId, makeDetails };
      }
    }
  }
  queueMicrotask(() => {
    if (mergedSignal.signal.aborted) {
      cancelStartedJob(job, mergedSignal, job.cancelReason ?? "Aborted");
      requestProgressRender();
      return;
    }
    void runSubagentWorker(
      pi,
      ctx,
      agents,
      params.agent,
      task,
      debug,
      parentModel,
      parentThinking,
      makeDetails,
      requestId,
      job,
      mergedSignal,
    );
  });
  await Promise.resolve();
  if (mergedSignal.signal.aborted) {
    return { kind: "cancelled", requestId, makeDetails };
  }
  return { kind: "started", requestId, makeDetails };
}

export async function runCommandHandler(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  const parsed = parseRunArgs(args);
  if (!parsed) {
    ctx.ui.notify("Usage: /run <agent> [task]", "error");
    return;
  }
  const { agentName, task, debug } = parsed;
  const result = await startSubagentJob(
    pi,
    ctx,
    { agent: agentName, task, debug },
    ctx.signal,
  );
  if (result.kind === "not_found") {
    ctx.ui.notify(`Unknown agent: ${agentName}`, "error");
  } else if (result.kind === "cancelled") {
    ctx.ui.notify("Cancelled", "info");
  }
}

export function getCachedAgentCompletions(
  agentCache: Map<string, { agents: AgentConfig[]; ts: number }>,
  cacheTtlMs: number,
  prefix: string,
): { value: string; label: string }[] {
  const cwd = process.cwd();
  const now = Date.now();
  let entry = agentCache.get(cwd);
  if (!entry || now - entry.ts > cacheTtlMs) {
    entry = { agents: discoverAgents(cwd, "both").agents, ts: now };
    agentCache.set(cwd, entry);
  }
  return entry.agents
    .filter((agent) => agent.name.startsWith(prefix))
    .map((agent) => ({ value: agent.name, label: agent.name }));
}
