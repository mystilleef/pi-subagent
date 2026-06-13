/**
 * Formatting and rendering helpers for subagent progress display.
 *
 * Pure presentation logic extracted from progress-state.js. No state
 * management or store access — only transforms data into display strings.
 */

import {
  normalizeAndTruncate,
  normalizeSummaryValue,
  truncateText,
} from "../output/normalize.js";
import type { ToolActivity } from "../shared/types.js";
import type { SubagentProgressState } from "./progress-state.js";

export const SENSITIVE_PATTERN = /secret|token|password/i;

const REDACTED_PLACEHOLDER = "(running...)";
const REDACTED_PLACEHOLDER_LENGTH = REDACTED_PLACEHOLDER.length;

function redactOrTruncate(text: string, maxChars: number): string {
  if (SENSITIVE_PATTERN.test(text))
    return maxChars >= REDACTED_PLACEHOLDER_LENGTH ? REDACTED_PLACEHOLDER : "";
  return truncateText(text, maxChars);
}

function walkActivityTree(activity: ToolActivity): string[] {
  const parts: string[] = [];
  let current: ToolActivity | undefined = activity;
  while (current) {
    if (current.inputSummary) {
      const annotated = current.instanceName
        ? `${current.inputSummary} [${current.instanceName}]`
        : current.inputSummary;
      parts.push(annotated);
    }
    current = current.child;
  }
  return parts;
}

/**
 * Format a millisecond duration for compact display.
 * Renders sub-minute durations as decimal seconds (`45.2s`),
 * longer durations as minutes and whole seconds (`2m 15s`).
 */
export function formatElapsed(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatContextPercent(state: {
  contextTokens?: number | undefined;
  contextWindowTokens?: number | undefined;
}): string {
  const windowTokens = state.contextWindowTokens;
  if (!windowTokens || windowTokens <= 0 || !Number.isFinite(windowTokens))
    return "--%";
  const usedTokens = state.contextTokens;
  if (!usedTokens || usedTokens <= 0 || !Number.isFinite(usedTokens))
    return "0%";
  return `${Math.round((usedTokens / windowTokens) * 100)}%`;
}

/**
 * Format the one-line statistics header for a subagent progress display.
 * Includes tool count, context window usage, and elapsed time.
 * When the subagent is still running (`durationMs` unset), elapsed is
 * computed live from `startTime`.
 *
 * @returns Single line, e.g. `"3 tools · 45% ctx · 12.3s"`
 */
export function formatHeaderStats(state: SubagentProgressState): string {
  const elapsedMs = state.durationMs ?? Date.now() - state.startTime;
  const toolLabel = state.toolCount === 1 ? "tool" : "tools";
  return `${state.toolCount} ${toolLabel} · ${formatContextPercent(state)} ctx · ${formatElapsed(elapsedMs)}`;
}

/**
 * Renders a ToolActivity tree for storage. Each segment is
 * independently normalized and truncated to TOOL_PREVIEW_MAX_CHARS (120).
 */
export function renderToolActivity(
  activity: ToolActivity | undefined,
): string | undefined {
  if (!activity) return undefined;
  const parts = walkActivityTree(activity);
  if (parts.length === 0) return activity.toolName;
  const result = parts.map((p) => normalizeAndTruncate(p)).join(" - ");
  if (SENSITIVE_PATTERN.test(result)) return REDACTED_PLACEHOLDER;
  return result;
}

/**
 * Renders a ToolActivity tree for display with a caller-provided truncation
 * budget. Segments are normalized without individual truncation so the
 * joined result shares one post-join display budget.
 */
export function renderToolActivityForDisplay(
  activity: ToolActivity | undefined,
  maxChars: number,
): string | undefined {
  if (!activity) return undefined;
  if (maxChars <= 0) return "";
  const parts = walkActivityTree(activity);
  if (parts.length === 0) return redactOrTruncate(activity.toolName, maxChars);
  const joined = parts.map((p) => normalizeSummaryValue(p)).join(" - ");
  return redactOrTruncate(joined, maxChars);
}
