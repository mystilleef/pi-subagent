import path from "node:path";
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
export type AgentDiscoveryCacheEntry = {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  ts: number;
};
export type AgentDiscoveryCache = Map<string, AgentDiscoveryCacheEntry>;
export const AGENT_DISCOVERY_CACHE_TTL_MS = 3_000;
const sharedAgentDiscoveryCache: AgentDiscoveryCache = new Map();
function getAgentDiscoveryCacheKey(cwd: string, scope: AgentScope): string {
  return `${path.resolve(cwd)}\0${scope}`;
}
function hasFreshAgentDiscoveryCacheEntry(
  entry: AgentDiscoveryCacheEntry | undefined,
  now: number,
  cacheTtlMs: number,
): entry is AgentDiscoveryCacheEntry {
  return Boolean(entry && now - entry.ts <= cacheTtlMs);
}
export function resetAgentDiscoveryCache(): void {
  sharedAgentDiscoveryCache.clear();
}
export function getCachedAgentDiscovery(
  cwd: string,
  scope: AgentScope,
  cache: AgentDiscoveryCache = sharedAgentDiscoveryCache,
  cacheTtlMs = AGENT_DISCOVERY_CACHE_TTL_MS,
): AgentDiscoveryCacheEntry {
  const key = getAgentDiscoveryCacheKey(cwd, scope);
  const now = Date.now();
  const entry = cache.get(key);
  if (hasFreshAgentDiscoveryCacheEntry(entry, now, cacheTtlMs)) return entry;
  const nextEntry = { ...discoverAgents(cwd, scope), ts: now };
  cache.set(key, nextEntry);
  return nextEntry;
}

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
  const includeMessages =
    includeDebugMessages && (options?.includeMessages ?? true);
  const target = {} as SingleResult;
  target.agent = result.agent;
  target.agentSource = result.agentSource;
  target.task = result.task;
  target.exitCode = result.exitCode;
  target.finalOutput = result.finalOutput;
  target.stderr = includeDebugMessages ? result.stderr : "";
  target.usage = {
    input: result.usage.input,
    output: result.usage.output,
    cacheRead: result.usage.cacheRead,
    cacheWrite: result.usage.cacheWrite,
    cost: result.usage.cost,
    contextTokens: result.usage.contextTokens,
    turns: result.usage.turns,
  };
  if (result.model !== undefined) target.model = result.model;
  if (result.stopReason !== undefined) target.stopReason = result.stopReason;
  if (result.errorMessage !== undefined)
    target.errorMessage = result.errorMessage;
  if (result.durationMs !== undefined) target.durationMs = result.durationMs;
  if (result.usage.contextWindowTokens !== undefined)
    target.usage.contextWindowTokens = result.usage.contextWindowTokens;
  if (result.progress !== undefined) {
    target.progress = {
      toolCalls: result.progress.toolCalls.map((tc) => ({
        id: tc.id,
        preview: tc.preview,
      })),
    };
    if (result.progress.activityText !== undefined)
      target.progress.activityText = result.progress.activityText;
    if (result.progress.lastToolPreview !== undefined)
      target.progress.lastToolPreview = result.progress.lastToolPreview;
  }
  if (includeMessages) {
    if (options?.recentMessages) target.messages = [...options.recentMessages];
    else if (result.messages !== undefined)
      target.messages = [...result.messages];
    if (includeDebugMessages && result.termination !== undefined) {
      target.termination = {
        cancelRequestedAt: result.termination.cancelRequestedAt,
        escalated: result.termination.escalated,
        processTreeKilled: result.termination.processTreeKilled,
        target: result.termination.target,
      };
      if (result.termination.cancelReason !== undefined)
        target.termination.cancelReason = result.termination.cancelReason;
      if (result.termination.terminationSignal !== undefined)
        target.termination.terminationSignal =
          result.termination.terminationSignal;
      if (result.termination.fallbackCause !== undefined)
        target.termination.fallbackCause = result.termination.fallbackCause;
    }
  }
  return target;
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
  _options: { expanded: boolean },
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
  current.toolCount += newToolCallIds.length;
  if (lastToolPreview) current.lastToolPreview = lastToolPreview;
  if (latestResult?.usage) {
    current.inputTokens = latestResult.usage.input;
    current.outputTokens = latestResult.usage.output;
    current.contextTokens = latestResult.usage.contextTokens;
    current.contextWindowTokens = latestResult.usage.contextWindowTokens;
  }
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

function cancelStartedJob(job: RunJob, reason: string): void {
  cancelProgressState(job.requestId, reason);
  removeRunJob(job.requestId);
}

function sendSubagentResultMessage(
  pi: ExtensionAPI,
  content: string,
  details: SubagentDetails,
): void {
  pi.sendMessage({
    customType: "subagent-result",
    content,
    display: true,
    details,
  });
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
  mergedSignal: AbortSignal,
): Promise<void> {
  const seenToolCallIds = new Set<string>();
  const requestProgressRender = createProgressRenderRequester(ctx, requestId);
  const onUpdate: OnUpdateCallback = (result) => {
    patchProgressFromDetails(requestId, result.details, seenToolCallIds);
    requestProgressRender();
  };
  function handleWorkerFailure(
    errorMessage: string,
    isAborted: boolean,
    details: SubagentDetails,
  ) {
    if (isAborted) {
      cancelProgressState(requestId, job.cancelReason ?? errorMessage);
    } else {
      failProgressState(requestId, errorMessage);
      ctx.ui?.notify(errorMessage, "error");
      const content = details.results[0]
        ? formatSubagentResultForParent(details.results[0] as SingleResult) ||
          "(failed)"
        : errorMessage;
      sendSubagentResultMessage(
        pi,
        content,
        sanitizeDetailsForDisplay(details, debug),
      );
    }
  }
  try {
    const result = await runSingleAgent(
      ctx.cwd,
      agents,
      agentName,
      task,
      mergedSignal,
      onUpdate,
      makeDetails,
      parentModel,
      parentThinking,
    );
    if (hasSubagentFailed(result)) {
      handleWorkerFailure(
        mergedSignal.aborted ? "Aborted" : createSubagentError(result).message,
        mergedSignal.aborted,
        makeDetails([result]),
      );
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
      sendSubagentResultMessage(
        pi,
        getResultDisplayText(toolResult),
        sanitizeDetailsForDisplay(toolResult.details, debug),
      );
    }
  } catch (error) {
    handleWorkerFailure(
      error instanceof Error ? error.message : String(error),
      mergedSignal.aborted,
      makeDetails([]),
    );
  } finally {
    requestProgressRender();
    removeRunJob(requestId);
  }
}

export type StartJobResult =
  | { kind: "started"; requestId: string; makeDetails: DetailsBuilder }
  | { kind: "cancelled"; makeDetails: DetailsBuilder }
  | { kind: "not_found"; makeDetails: DetailsBuilder };

export function formatStartJobStatus(
  agentName: string,
  result: StartJobResult,
): string {
  if (result.kind === "not_found") return `Unknown agent: "${agentName}"`;
  if (result.kind === "cancelled") return "Canceled";
  return `Subagent ${agentName} started (job: ${result.requestId})`;
}

function needsProjectAgentConfirmation(
  ctx: ExtensionContext,
  agent: AgentConfig,
): boolean {
  return ctx.hasUI && agent.source === "project";
}

function confirmProjectAgentRun(
  ctx: ExtensionContext,
  agent: AgentConfig,
  projectAgentsDir: string | null,
): Promise<boolean> {
  const dir = projectAgentsDir ?? "(unknown)";
  return ctx.ui.confirm(
    "Run project-local agent?",
    `Agent: ${agent.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
}

export async function startSubagentJob(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Static<typeof SubagentParams>,
  hostSignal: AbortSignal | undefined,
): Promise<StartJobResult> {
  const agentScope: AgentScope = params.agentScope ?? "both";
  const discovery = getCachedAgentDiscovery(ctx.cwd, agentScope);
  const agents = discovery.agents;
  const debug = params.debug === true;
  const makeDetails = createDetailsBuilder(
    agentScope,
    discovery.projectAgentsDir,
    debug,
  );
  const requested = agents.find((a) => a.name === params.agent);
  if (!requested) return { kind: "not_found", makeDetails };
  const task = params.task?.trim() ?? "";
  if (needsProjectAgentConfirmation(ctx, requested)) {
    const confirmed = await confirmProjectAgentRun(
      ctx,
      requested,
      discovery.projectAgentsDir,
    );
    if (!confirmed) return { kind: "cancelled", makeDetails };
  }
  const parentModel = ctx.model
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : undefined;
  const parentThinking = pi.getThinkingLevel() as ThinkingLevel;
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  const job: RunJob = registerRunJob({
    requestId,
    agentName: params.agent,
    controller,
    startedAt: Date.now(),
  });
  const mergedSignal = hostSignal
    ? AbortSignal.any([hostSignal, job.controller.signal])
    : job.controller.signal;
  createProgressState(requestId, params.agent, task);
  pi.sendMessage({
    customType: "subagent-progress",
    content: "",
    display: true,
    details: { requestId },
  });
  const requestProgressRender = createProgressRenderRequester(ctx, requestId);
  setImmediate(() => {
    if (mergedSignal.aborted) {
      cancelStartedJob(job, job.cancelReason ?? "Aborted");
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
  if (mergedSignal.aborted) return { kind: "cancelled", makeDetails };
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
  prefix: string,
  cwd = process.cwd(),
  cache: AgentDiscoveryCache = sharedAgentDiscoveryCache,
  cacheTtlMs = AGENT_DISCOVERY_CACHE_TTL_MS,
): { value: string; label: string }[] {
  return getCachedAgentDiscovery(cwd, "both", cache, cacheTtlMs)
    .agents.filter((agent) => agent.name.startsWith(prefix))
    .map((agent) => ({ value: agent.name, label: agent.name }));
}
