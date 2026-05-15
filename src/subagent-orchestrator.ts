import { type Message, StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { getCachedAgentDiscovery } from "./agent-cache.js";
import {
  type AgentConfig,
  type AgentScope,
  discoverAgents,
  type ThinkingLevel,
} from "./agents.js";
import { generateSubagentInstanceName } from "./instance-name.js";
import { runSingleAgent } from "./process.js";
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
} from "./progress.js";
import {
  createSubagentError,
  getFeedbackSummaryText,
  getResultDisplayText,
  hasSubagentFailed,
  patchProgressFromDetails,
  sanitizeDetailsForDisplay,
} from "./result-details.js";
import { type RunJob, registerRunJob, removeRunJob } from "./run-registry.js";
import { formatSubagentResultForParent } from "./summary.js";
import type {
  OnUpdateCallback,
  SingleResult,
  SubagentDetails,
  SubagentToolResult,
} from "./types.js";

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
  | {
      kind: "started";
      requestId: string;
      instanceName: string;
      makeDetails: DetailsBuilder;
    }
  | { kind: "cancelled"; makeDetails: DetailsBuilder }
  | { kind: "not_found"; makeDetails: DetailsBuilder };

export function formatStartJobStatus(
  agentName: string,
  result: StartJobResult,
): string {
  if (result.kind === "not_found") return `Unknown agent: "${agentName}"`;
  if (result.kind === "cancelled") return "Canceled";
  return `Subagent ${agentName} ${result.instanceName} started (job: ${result.requestId})`;
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
    const userAgents = discoverAgents(ctx.cwd, "user");
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
      makeStartedDetails,
      requestId,
      job,
      mergedSignal,
    );
  });
  if (mergedSignal.aborted) return { kind: "cancelled", makeDetails };
  return {
    kind: "started",
    requestId,
    instanceName,
    makeDetails: makeStartedDetails,
  };
}
