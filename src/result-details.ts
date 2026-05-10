import { TOOL_RESULT_FAILED_MESSAGE } from "./process.js";
import {
  extractProgressFromDetails,
  getProgressState,
  patchProgressState,
} from "./progress.js";
import {
  formatSubagentResultForParent,
  summarizeFeedbackUiFinalOutput,
} from "./summary.js";
import type {
  SingleResult,
  SubagentDetails,
  SubagentToolResult,
} from "./types.js";
import { detectMessageError } from "./utils.js";

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
  const patch: Record<string, unknown> = {
    toolCount: current.toolCount + newToolCallIds.length,
  };
  if (lastToolPreview) patch.lastToolPreview = lastToolPreview;
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
  return result.details.results[0]?.finalOutput ?? getSubagentText(result);
}

export function getFeedbackSummaryText(result: SubagentToolResult): string {
  const rawFinalOutput = result.details.results[0]?.finalOutput;
  if (rawFinalOutput?.trim())
    return summarizeFeedbackUiFinalOutput(rawFinalOutput);
  return getSubagentText(result).trim() || "(no output)";
}
