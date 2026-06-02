import { TOOL_RESULT_FAILED_MESSAGE } from "../child/process.js";
import {
  formatSubagentResultForParent,
  summarizeFeedbackUiFinalOutput,
} from "../output/summary.js";
import type {
  ActivityFrame,
  SingleResult,
  SubagentDetails,
  SubagentToolResult,
} from "../shared/types.js";
import { detectMessageError } from "../shared/utils.js";
import {
  extractProgressFromDetails,
  getProgressState,
  patchProgressState,
  renderActivityStack,
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
  _previous: { activityText?: string; lastToolPreview?: string } | undefined,
  _currentStack?: ActivityFrame[],
  previousStack?: ActivityFrame[],
): boolean {
  if (!current.activityText || current.lastToolPreview) return false;
  // Stack-based detection only: multi-frame stack indicates nested activity
  return previousStack !== undefined && previousStack.length > 1;
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
    activityStack,
    toolResultCompleted,
  } = extractProgressFromDetails(details, seenToolCallIds);
  const current = getProgressState(requestId);
  if (!current) return;
  const patch: Record<string, unknown> = {
    toolCount: current.toolCount + newToolCallIds.length,
  };
  // Stack transitions
  let nextStack: ActivityFrame[] | undefined;
  let isSingleFrameEcho = false;
  if (newToolCallIds.length > 0 && lastToolPreview) {
    // Fresh direct child tool call → reset stack to one frame
    nextStack = [{ preview: lastToolPreview }];
  } else if (activityStack && activityStack.length > 0) {
    // Nested activity with stack → copy incoming stack for immutability
    nextStack = activityStack.map((f) => ({ ...f }));
  } else if (activityText) {
    // Structural check: single-frame echo detection
    const currentHasMatchingSingleFrame =
      current.activityStack &&
      current.activityStack.length === 1 &&
      current.activityStack[0]?.preview === activityText;
    if (currentHasMatchingSingleFrame) {
      isSingleFrameEcho = true;
      nextStack = current.activityStack;
    } else {
      // Nested activity without stack → build single-frame stack from activityText
      nextStack = [{ preview: activityText }];
    }
  } else if (current.activityStack && current.activityStack.length > 0) {
    // No new stack info → preserve current
    nextStack = current.activityStack;
  }
  // Pop leaf frame on explicit completion signal
  if (toolResultCompleted && nextStack && nextStack.length > 0) {
    nextStack = nextStack.slice(0, -1);
    if (nextStack.length === 0) {
      nextStack = undefined;
    }
  }
  // Apply stack and derive preview (skip during single-frame echo to preserve stored state)
  if (!isSingleFrameEcho) {
    patch.activityStack = nextStack;
    const renderedPreview = renderActivityStack(nextStack);
    if (renderedPreview) {
      patch.lastToolPreview = renderedPreview;
    } else if (toolResultCompleted && !nextStack) {
      // Clear preview when stack is empty after pop
      patch.lastToolPreview = undefined;
    }
  }
  // Expose completion signal
  if (toolResultCompleted) {
    patch.toolResultCompleted = true;
  }
  // Token accounting with nested-only guard
  const isNestedOnlyUpdate = isNestedOnlyActivityUpdate(
    { activityText, lastToolPreview },
    latestResult?.progress,
    current.activityStack,
    latestResult?.progress?.activityStack,
  );
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
