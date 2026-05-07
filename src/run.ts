import { type Message, StringEnum } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
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

function createDetailsBuilder(
  agentScope: AgentScope,
  projectAgentsDir: string | null,
  includeDebugMessages: boolean,
): (results: SingleResult[], options?: DetailsOptions) => SubagentDetails {
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

function createCanceledResult(details: SubagentDetails): SubagentToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: "Canceled: project-local agent not approved.",
      },
    ],
    details,
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

export async function executeSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Static<typeof SubagentParams>,
  signal: AbortSignal,
  onUpdate?: OnUpdateCallback,
): Promise<SubagentToolResult> {
  const agentScope: AgentScope = params.agentScope ?? "both";
  const discovery = discoverAgents(ctx.cwd, agentScope);
  const agents = discovery.agents;
  const parentModel = ctx.model
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : undefined;
  const parentThinking = pi.getThinkingLevel() as ThinkingLevel;
  const makeDetails = createDetailsBuilder(
    agentScope,
    discovery.projectAgentsDir,
    params.debug === true,
  );
  if ((agentScope === "project" || agentScope === "both") && ctx.hasUI) {
    const requested = agents.find((a) => a.name === params.agent);
    if (requested?.source === "project") {
      const dir = discovery.projectAgentsDir ?? "(unknown)";
      const ok = await ctx.ui.confirm(
        "Run project-local agent?",
        `Agent: ${requested.name}
Source: ${dir}

Project agents are repo-controlled. Only continue for trusted repositories.`,
      );
      if (!ok) return createCanceledResult(makeDetails([]));
    }
  }
  const task = params.task?.trim() ?? "";
  const result = await runSingleAgent(
    ctx.cwd,
    agents,
    params.agent,
    task,
    signal,
    onUpdate,
    makeDetails,
    parentModel,
    parentThinking,
  );
  if (hasSubagentFailed(result)) throw createSubagentError(result);
  return {
    content: [
      {
        type: "text" as const,
        text: formatSubagentResultForParent(result) || "(no output)",
      },
    ],
    details: makeDetails([result]),
  };
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
): { signal: AbortSignal; cleanup: () => void } {
  const relay = new AbortController();
  const abortFromHost = () => relay.abort(hostSignal?.reason);
  const abortFromJob = () => relay.abort(jobSignal.reason);
  if (hostSignal?.aborted) abortFromHost();
  else hostSignal?.addEventListener("abort", abortFromHost, { once: true });
  if (jobSignal.aborted) abortFromJob();
  else jobSignal.addEventListener("abort", abortFromJob, { once: true });
  return {
    signal: relay.signal,
    cleanup: () => {
      hostSignal?.removeEventListener("abort", abortFromHost);
      jobSignal.removeEventListener("abort", abortFromJob);
    },
  };
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
  const discovery = discoverAgents(ctx.cwd, "both");
  if (!discovery.agents.find((a) => a.name === agentName)) {
    ctx.ui.notify(`Unknown agent: ${agentName}`, "error");
    return;
  }
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  const job: RunJob = registerRunJob({
    requestId,
    agentName,
    controller,
    startedAt: Date.now(),
  });
  const mergedSignal = createMergedRunSignal(ctx.signal, job.controller.signal);
  createProgressState(requestId, agentName, task);
  // Commands lack a public mutable tool-result lifecycle. Emit one
  // progress entry only; later session renders read final state by
  // requestId without appending duplicate progress messages.
  pi.sendMessage({
    customType: "subagent-progress",
    content: "",
    display: true,
    details: { requestId },
  });
  const seenToolCallIds = new Set<string>();
  const progressRenderKey = `subagent-progress:${requestId}`;
  const requestProgressRender = () => {
    ctx.ui.setStatus?.(progressRenderKey, `${Date.now()}`);
    ctx.ui.setStatus?.(progressRenderKey, undefined);
  };
  const onUpdate: OnUpdateCallback = (result) => {
    patchProgressFromDetails(requestId, result.details, seenToolCallIds);
    requestProgressRender();
  };
  try {
    const result = await executeSubagent(
      pi,
      ctx,
      { agent: agentName, task, debug },
      mergedSignal.signal,
      onUpdate,
    );
    const text = getSubagentText(result);
    const resultText = getResultDisplayText(result);
    const feedbackText = getFeedbackSummaryText(result);
    if (text.startsWith("Canceled")) {
      cancelProgressState(requestId, job.cancelReason ?? text);
      requestProgressRender();
    } else {
      finalizeProgressState(requestId, feedbackText);
      requestProgressRender();
      pi.sendMessage({
        customType: "subagent-result",
        content: resultText,
        display: true,
        details: sanitizeDetailsForDisplay(result.details, debug),
      });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (mergedSignal.signal.aborted) {
      cancelProgressState(requestId, job.cancelReason ?? errorMsg);
    } else {
      failProgressState(requestId, errorMsg);
    }
    requestProgressRender();
    ctx.ui.notify(errorMsg, "error");
  } finally {
    mergedSignal.cleanup();
    removeRunJob(requestId);
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
