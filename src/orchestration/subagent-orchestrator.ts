import { type Message, StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { getCachedAgentDiscovery } from "../agent/agent-cache.js";
import type {
  AgentConfig,
  AgentScope,
  ThinkingLevel,
} from "../agent/agents.js";
import { makeNestedActivityLine } from "../child/child-events.js";
import { runSingleAgent, SubagentAbortError } from "../child/process.js";
import { formatSubagentResultForParent } from "../output/summary.js";
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  getProgressState,
} from "../progress/progress.js";
import {
  createSubagentError,
  getFeedbackSummaryText,
  getLatestResult,
  getResultDisplayText,
  hasSubagentFailed,
  patchProgressFromDetails,
  sanitizeDetailsForDisplay,
} from "../progress/result-details.js";
import { generateSubagentInstanceName } from "../shared/instance-name.js";
import type {
  OnUpdateCallback,
  SingleResult,
  SubagentDetails,
  SubagentToolResult,
} from "../shared/types.js";
import { getSubagentDepth } from "../shared/utils.js";
import {
  listRunJobs,
  type RunJob,
  registerRunJob,
  removeRunJob,
} from "./run-registry.js";

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

export type { SubagentToolResult };

type DetailsOptions = { includeMessages?: boolean; recentMessages?: Message[] };
type DetailsBuilder = (
  results: SingleResult[],
  options?: DetailsOptions,
) => SubagentDetails;

interface LifecycleContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  requestId: string;
  job: RunJob;
  debug: boolean;
  makeDetails: DetailsBuilder;
  mergedSignal: AbortSignal;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  parentModel: { provider: string; id: string } | undefined;
  parentThinking: ThinkingLevel;
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
  const { messages, termination, progress, stderr, usage, ...core } = result;
  const { contextWindowTokens, ...usageBase } = usage;
  const sanitized: Record<string, unknown> = {
    ...core,
    stderr: includeDebugMessages ? stderr : "",
    usage: { ...usageBase },
  };
  if (contextWindowTokens !== undefined) {
    (sanitized.usage as Record<string, unknown>).contextWindowTokens =
      contextWindowTokens;
  }
  if (progress !== undefined) {
    const { activityText, lastToolPreview, ...progBase } = progress;
    sanitized.progress = {
      toolCalls: progBase.toolCalls.map((tc) => ({
        id: tc.id,
        preview: tc.preview,
      })),
      ...(activityText !== undefined && { activityText }),
      ...(lastToolPreview !== undefined && { lastToolPreview }),
    };
  }
  if (includeMessages) {
    sanitized.messages = options?.recentMessages
      ? [...options.recentMessages]
      : messages !== undefined
        ? [...messages]
        : undefined;
    if (includeDebugMessages && termination !== undefined) {
      const { cancelReason, terminationSignal, fallbackCause, ...termBase } =
        termination;
      sanitized.termination = {
        ...termBase,
        ...(cancelReason !== undefined && { cancelReason }),
        ...(terminationSignal !== undefined && { terminationSignal }),
        ...(fallbackCause !== undefined && { fallbackCause }),
      };
    }
  }
  return sanitized as unknown as SingleResult;
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

export function emitCompletionAlert(
  state: ReturnType<typeof getProgressState>,
): void {
  if (!state) return;
  if (state.status === "cancelled") return;
  const tty = (process.stdout as { isTTY?: boolean }).isTTY;
  if (!tty) return;
  process.stdout.write("\x07");
}

function createCompletedToolResult(
  content: string,
  details: SubagentDetails,
): SubagentToolResult {
  return {
    content: [{ type: "text", text: content }],
    details: { ...details, renderedByMessage: true },
  };
}

function finishLifecycleFailure(
  lc: LifecycleContext,
  errorMessage: string,
  details: SubagentDetails,
): SubagentToolResult {
  const displayDetails = sanitizeDetailsForDisplay(details, lc.debug);
  if (lc.mergedSignal.aborted) {
    cancelProgressState(lc.requestId, lc.job.cancelReason ?? errorMessage);
    if (getSubagentDepth() > 0) {
      sendSubagentResultMessage(lc.pi, "Canceled", displayDetails);
    }
    return createCompletedToolResult("Canceled", displayDetails);
  }
  failProgressState(lc.requestId, errorMessage);
  lc.ctx.ui?.notify(errorMessage, "error");
  const latestResult = getLatestResult(details);
  const content = latestResult
    ? formatSubagentResultForParent(latestResult) || "(failed)"
    : errorMessage;
  sendSubagentResultMessage(lc.pi, content, displayDetails);
  return createCompletedToolResult(content, displayDetails);
}

function finishLifecycleResult(
  lc: LifecycleContext,
  result: SingleResult,
): SubagentToolResult {
  const details = lc.makeDetails([result]);
  if (hasSubagentFailed(result)) {
    return finishLifecycleFailure(
      lc,
      lc.mergedSignal.aborted ? "Aborted" : createSubagentError(result).message,
      details,
    );
  }
  const displayDetails = sanitizeDetailsForDisplay(details, lc.debug);
  const content = formatSubagentResultForParent(result) || "(no output)";
  const toolResult = createCompletedToolResult(content, displayDetails);
  finalizeProgressState(lc.requestId, getFeedbackSummaryText(toolResult));
  sendSubagentResultMessage(
    lc.pi,
    getResultDisplayText(toolResult),
    displayDetails,
  );
  return toolResult;
}

function emitNestedActivity(details: SubagentDetails): void {
  const activityText = getLatestResult(details)?.progress?.activityText;
  if (activityText) {
    process.stdout.write(`${makeNestedActivityLine(activityText)}\n`);
  }
}

async function runSubagentLifecycle(
  lc: LifecycleContext,
): Promise<SubagentToolResult> {
  const seenToolCallIds = new Set<string>();
  const requestProgressRender = createProgressRenderRequester(
    lc.ctx,
    lc.requestId,
  );
  const isNested = getSubagentDepth() > 0;
  const onUpdate: OnUpdateCallback = (result) => {
    patchProgressFromDetails(lc.requestId, result.details, seenToolCallIds);
    if (isNested) emitNestedActivity(result.details);
    requestProgressRender();
  };
  const timerTick = setInterval(requestProgressRender, 500);
  try {
    const result = await runSingleAgent(
      lc.ctx.cwd,
      lc.agents,
      lc.agentName,
      lc.task,
      lc.mergedSignal,
      onUpdate,
      lc.makeDetails,
      lc.parentModel,
      lc.parentThinking,
    );
    return finishLifecycleResult(lc, result);
  } catch (error) {
    const abortResult =
      error instanceof SubagentAbortError ? error.result : undefined;
    return finishLifecycleFailure(
      lc,
      error instanceof Error ? error.message : String(error),
      abortResult ? lc.makeDetails([abortResult]) : lc.makeDetails([]),
    );
  } finally {
    clearInterval(timerTick);
    requestProgressRender();
    removeRunJob(lc.requestId);
    if (listRunJobs().length === 0) {
      const state = getProgressState(lc.requestId);
      if (state) {
        emitCompletionAlert(state);
      }
    }
  }
}

type StartJobResult =
  | {
      kind: "started";
      requestId: string;
      instanceName: string;
      makeDetails: DetailsBuilder;
    }
  | { kind: "completed"; result: SubagentToolResult }
  | { kind: "cancelled"; makeDetails: DetailsBuilder }
  | { kind: "not_found"; makeDetails: DetailsBuilder };

type PrepareSubagentJobResult =
  | {
      kind: "ready";
      lc: LifecycleContext;
      instanceName: string;
      requestProgressRender: () => void;
    }
  | { kind: "not_found"; makeDetails: DetailsBuilder }
  | { kind: "cancelled"; makeDetails: DetailsBuilder }
  | { kind: "aborted"; makeDetails: DetailsBuilder };

export function formatSubagentToolResult(
  agentName: string,
  result: StartJobResult,
): SubagentToolResult {
  if (result.kind === "completed") return result.result;
  let text: string;
  if (result.kind === "not_found") text = `Unknown agent: "${agentName}"`;
  else if (result.kind === "cancelled") text = "Canceled";
  else
    text = `Subagent ${agentName} ${result.instanceName} started (job: ${result.requestId})`;
  return {
    content: [{ type: "text", text }],
    details: result.makeDetails([]),
  };
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

async function prepareSubagentJob(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Static<typeof SubagentParams>,
  hostSignal: AbortSignal | undefined,
): Promise<PrepareSubagentJobResult> {
  const agentScope: AgentScope = params.agentScope ?? "both";
  const discovery = await getCachedAgentDiscovery(ctx.cwd, agentScope);
  const agents = discovery.agents;
  const debug = params.debug === true;
  const makeDetails = createDetailsBuilder(
    agentScope,
    discovery.projectAgentsDir,
    debug,
  );
  const requested = agents.find((a) => a.name === params.agent);
  if (!requested) return { kind: "not_found", makeDetails };
  if (hostSignal?.aborted) return { kind: "cancelled", makeDetails };
  const task = params.task?.trim() ?? "";
  if (needsProjectAgentConfirmation(ctx, requested)) {
    const confirmed = await confirmProjectAgentRun(
      ctx,
      requested,
      discovery.projectAgentsDir,
    );
    if (!confirmed) return { kind: "cancelled", makeDetails };
  }
  if (requested.source === "project") {
    const userAgents = await getCachedAgentDiscovery(ctx.cwd, "user");
    const hasUserCollision = userAgents.agents.some(
      (a) => a.name === requested.name,
    );
    if (hasUserCollision) {
      pi.sendMessage({
        customType: "subagent-progress",
        content: `Using project agent "${requested.name}"; user agent with same name also exists.`,
        display: true,
        details: {},
      });
    }
  }
  const parentModel = ctx.model
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : undefined;
  const parentThinking = pi.getThinkingLevel() as ThinkingLevel;
  const requestId = crypto.randomUUID();
  const instanceName = generateSubagentInstanceName();
  const controller = new AbortController();
  const job: RunJob = registerRunJob({
    requestId,
    agentName: params.agent,
    instanceName,
    controller,
    startedAt: Date.now(),
  });
  const mergedSignal = hostSignal
    ? AbortSignal.any([hostSignal, job.controller.signal])
    : job.controller.signal;
  const makeStartedDetails: DetailsBuilder = (results, options) =>
    makeDetails(
      results.map((result) => ({ ...result, instanceName })),
      options,
    );
  createProgressState(requestId, params.agent, task, instanceName);
  pi.sendMessage({
    customType: "subagent-progress",
    content: "",
    display: true,
    details: { agent: params.agent, instanceName, requestId },
  });
  const requestProgressRender = createProgressRenderRequester(ctx, requestId);
  if (mergedSignal.aborted) {
    cancelStartedJob(job, job.cancelReason ?? "Aborted");
    requestProgressRender();
    return { kind: "aborted", makeDetails: makeStartedDetails };
  }
  return {
    kind: "ready",
    lc: {
      pi,
      ctx,
      requestId,
      job,
      debug,
      makeDetails: makeStartedDetails,
      mergedSignal,
      agents,
      agentName: params.agent,
      task,
      parentModel,
      parentThinking,
    },
    instanceName,
    requestProgressRender,
  };
}

export async function startSubagentJob(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Static<typeof SubagentParams>,
  hostSignal: AbortSignal | undefined,
): Promise<StartJobResult> {
  const prepared = await prepareSubagentJob(pi, ctx, params, hostSignal);
  if (prepared.kind !== "ready") {
    if (prepared.kind === "aborted")
      return { kind: "cancelled", makeDetails: prepared.makeDetails };
    return prepared;
  }
  const { lc, instanceName, requestProgressRender } = prepared;
  if (getSubagentDepth() > 0) {
    const result = await runSubagentLifecycle(lc);
    return { kind: "completed", result };
  }
  setImmediate(() => {
    if (lc.mergedSignal.aborted) {
      cancelStartedJob(lc.job, lc.job.cancelReason ?? "Aborted");
      requestProgressRender();
      return;
    }
    runSubagentLifecycle(lc);
  });
  return {
    kind: "started",
    requestId: lc.requestId,
    instanceName,
    makeDetails: lc.makeDetails,
  };
}
