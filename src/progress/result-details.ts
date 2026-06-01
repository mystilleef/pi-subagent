import { TOOL_RESULT_FAILED_MESSAGE } from "../child/process.js";
import {
  formatSubagentResultForParent,
  summarizeFeedbackUiFinalOutput,
} from "../output/summary.js";
import type {
  SingleResult,
  SubagentDetails,
  SubagentToolResult,
} from "../shared/types.js";
import { detectMessageError } from "../shared/utils.js";
import {
  extractProgressFromDetails,
  getProgressState,
  patchProgressState,
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

function isNestedOnlyActivityUpdate(
  current: { activityText?: string; lastToolPreview?: string },
  previous: { activityText?: string; lastToolPreview?: string } | undefined,
): boolean {
  if (!current.activityText || current.lastToolPreview) return false;
  const prevHadCustomActivity =
    previous?.activityText !== previous?.lastToolPreview;
  return prevHadCustomActivity;
}

export function patchProgressFromDetails(
  requestId: string,
  details: SubagentDetails,
  seenToolCallIds: Set<string>,
): void {
  const latestResult = getLatestResult(details);
  const { newToolCallIds, lastToolPreview, activityText } =
    extractProgressFromDetails(details, seenToolCallIds);
  const current = getProgressState(requestId);
  if (!current) return;
  const patch: Record<string, unknown> = {
    toolCount: current.toolCount + newToolCallIds.length,
  };
  const effectivePreview = lastToolPreview ?? activityText;
  const isNestedOnlyUpdate = isNestedOnlyActivityUpdate(
    { activityText, lastToolPreview },
    latestResult?.progress,
  );
  if (effectivePreview) patch.lastToolPreview = effectivePreview;
  if (latestResult?.usage && !isNestedOnlyUpdate) {
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
