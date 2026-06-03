import { TOOL_RESULT_FAILED_MESSAGE } from "../child/process.js";
import {
  formatSubagentResultForParent,
  summarizeFeedbackUiFinalOutput,
} from "../output/summary.js";
import type {
  SingleResult,
  SubagentDetails,
  SubagentToolResult,
  ToolActivity,
} from "../shared/types.js";
import { detectMessageError } from "../shared/utils.js";
import {
  extractProgressFromDetails,
  getProgressState,
  patchProgressState,
  renderToolActivity,
} from "./progress.js";

export function hasSubagentFailed(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    Boolean(result.errorMessage?.trim()) ||
    detectMessageError(result.messages ?? [])
  );
}

export function createSubagentError(result: SingleResult): Error {
  const formatted = formatSubagentResultForParent(result);
  const errorMessage = result.errorMessage?.trim();
  if (errorMessage && errorMessage !== TOOL_RESULT_FAILED_MESSAGE)
    return new Error(`Agent ${result.stopReason || "failed"}: ${errorMessage}`);
  const msg =
    formatted ||
    result.stderr ||
    errorMessage ||
    result.finalOutput ||
    "(no output)";
  return new Error(`Agent ${result.stopReason || "failed"}: ${msg}`);
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

export function getLatestResult(
  details: SubagentDetails,
): SingleResult | undefined {
  return details.results[0];
}

export function patchProgressFromDetails(
  requestId: string,
  details: SubagentDetails,
  seenToolCallIds: Set<string>,
): void {
  const latestResult = getLatestResult(details);
  const {
    newToolCallIds,
    lastToolPreview,
    activityText,
    activeToolActivity,
    toolResultCompleted,
  } = extractProgressFromDetails(details, seenToolCallIds);
  const current = getProgressState(requestId);
  if (!current) return;
  const patch: Record<string, unknown> = {
    toolCount: current.toolCount + newToolCallIds.length,
  };
  let nextActivity: ToolActivity | undefined;
  if (newToolCallIds.length > 0 && lastToolPreview) {
    nextActivity = { toolName: "tool", inputSummary: lastToolPreview };
  } else if (activeToolActivity) {
    nextActivity = activeToolActivity;
  } else if (activityText) {
    nextActivity = { toolName: "tool", inputSummary: activityText };
  } else if (current.activeToolActivity) {
    nextActivity = current.activeToolActivity;
  }
  if (toolResultCompleted && nextActivity?.child) {
    nextActivity = { ...nextActivity, child: undefined };
  } else if (toolResultCompleted) {
    nextActivity = undefined;
  }
  patch.activeToolActivity = nextActivity;
  const renderedPreview = renderToolActivity(nextActivity);
  if (renderedPreview) {
    patch.lastToolPreview = renderedPreview;
  } else if (toolResultCompleted && !nextActivity) {
    patch.lastToolPreview = undefined;
  }
  if (toolResultCompleted) {
    patch.toolResultCompleted = true;
  }
  // Token accounting always applies when usage data is available
  if (latestResult?.usage) {
    patch.inputTokens = latestResult.usage.input;
    patch.outputTokens = latestResult.usage.output;
    patch.contextTokens = latestResult.usage.contextTokens;
    patch.contextWindowTokens = latestResult.usage.contextWindowTokens;
  }
  patchProgressState(
    requestId,
    patch as Parameters<typeof patchProgressState>[1],
  );
}

export function getSubagentText(result: SubagentToolResult): string {
  return (result.content[0] as { text?: string })?.text ?? "";
}

export function getResultDisplayText(result: SubagentToolResult): string {
  return (
    getLatestResult(result.details)?.finalOutput ?? getSubagentText(result)
  );
}

export function getFeedbackSummaryText(result: SubagentToolResult): string {
  const rawFinalOutput = getLatestResult(result.details)?.finalOutput;
  if (rawFinalOutput?.trim())
    return summarizeFeedbackUiFinalOutput(rawFinalOutput);
  return getSubagentText(result).trim() || "(no output)";
}
