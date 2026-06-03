import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  isStatusOnlyFailure,
  isStatusOnlySuccess,
  makeToolPreview,
  normalizeAndTruncate,
  normalizeSummaryValue,
  normalizeTerminalSentence,
  truncateText,
} from "../output/normalize.js";
import type {
  SingleResult,
  SubagentDetails,
  ToolActivity,
} from "../shared/types.js";

export const SENSITIVE_PATTERN = /secret|token|password/i;

export type ThemeBg = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export type ProgressStatus = "running" | "success" | "error" | "cancelled";

export const STATUS_COLOR: Record<ProgressStatus, ThemeColor> = {
  success: "success",
  error: "error",
  cancelled: "error",
  running: "accent",
};

export const STATUS_ICON: Record<ProgressStatus, string> = {
  success: "✓",
  error: "✗",
  cancelled: "⊘",
  running: "⟳",
};

export const STATUS_BG: Record<ProgressStatus, ThemeBg> = {
  success: "toolSuccessBg",
  error: "toolErrorBg",
  cancelled: "toolErrorBg",
  running: "toolPendingBg",
};

export interface SubagentProgressState {
  requestId: string;
  agent: string;
  instanceName?: string;
  taskPreview: string;
  status: ProgressStatus;
  startTime: number;
  durationMs?: number;
  activeToolActivity?: ToolActivity;
  lastToolPreview?: string;
  toolResultCompleted?: boolean;
  toolCount: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  contextWindowTokens?: number;
  finalOutput?: string;
  errorText?: string;
}

const store = new Map<string, SubagentProgressState>();

export function createProgressState(
  requestId: string,
  agent: string,
  task: string,
  instanceName?: string,
): void {
  store.set(requestId, {
    requestId,
    agent,
    instanceName,
    taskPreview: makeTaskPreview(task),
    status: "running",
    startTime: Date.now(),
    toolCount: 0,
  });
}

export function getProgressState(
  requestId: string,
): SubagentProgressState | undefined {
  return store.get(requestId);
}
export function getAllProgressStates(): SubagentProgressState[] {
  return [...store.values()].sort((a, b) => b.startTime - a.startTime);
}

export function patchProgressState(
  requestId: string,
  patch: Partial<SubagentProgressState>,
): void {
  const state = store.get(requestId);
  if (!state) return;
  if (state.status !== "running") {
    store.set(requestId, {
      ...state,
      ...patch,
      activeToolActivity: undefined,
      lastToolPreview: undefined,
      toolResultCompleted: undefined,
    });
    return;
  }
  store.set(requestId, { ...state, ...patch });
}

function storeTerminalProgressState(
  requestId: string,
  patch: Partial<SubagentProgressState>,
): void {
  const state = store.get(requestId);
  if (!state) return;
  const durationMs = state.durationMs ?? Date.now() - state.startTime;
  store.set(requestId, { ...state, ...patch, durationMs });
}

export function finalizeProgressState(
  requestId: string,
  finalOutput: string,
): void {
  storeTerminalProgressState(requestId, {
    status: "success",
    finalOutput: makeProgressFinalOutput(finalOutput),
    activeToolActivity: undefined,
    lastToolPreview: undefined,
    toolResultCompleted: undefined,
  });
}

export function failProgressState(requestId: string, errorText: string): void {
  const sentence = deriveFailureTerminalSentence(errorText);
  storeTerminalProgressState(requestId, {
    status: "error",
    errorText: sentence,
    activeToolActivity: undefined,
    lastToolPreview: undefined,
    toolResultCompleted: undefined,
  });
}

export function cancelProgressState(requestId: string, reason?: string): void {
  storeTerminalProgressState(requestId, {
    status: "cancelled",
    activeToolActivity: undefined,
    lastToolPreview: undefined,
    toolResultCompleted: undefined,
    ...(reason !== undefined
      ? { errorText: normalizeTerminalSentence(reason) }
      : {}),
  });
}

export function clearProgressState(requestId: string): void {
  store.delete(requestId);
}
export function resetProgressStore(): void {
  store.clear();
}

export function makeTaskPreview(task: string): string {
  const flat = normalizeSummaryValue(task);
  return flat || "(agent default)";
}

function makeProgressFinalOutput(finalOutput: string): string {
  const lines = finalOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const outcomeLine = lines.find((line) => /^Outcome:\s*/i.test(line));
  const selected = outcomeLine ?? lines[0] ?? "";
  const normalized = normalizeTerminalSentence(selected);
  if (!normalized) return "";
  if (isStatusOnlySuccess(normalized)) return "completed task";
  return normalized;
}

function deriveFailureTerminalSentence(errorText: string): string {
  const source = extractProgressSemanticErrorLine(errorText);
  if (!source || source === "Large unstructured error output omitted.")
    return source;
  const normalized = normalizeTerminalSentence(source);
  if (!normalized || isStatusOnlyFailure(normalized)) return "task failed";
  return normalized;
}

function extractProgressSemanticErrorLine(errorText: string): string {
  const lines = errorText
    .split(/\r?\n/)
    .map((line) => normalizeSummaryValue(line))
    .filter(Boolean);
  const statusLine = lines.find((line) =>
    /^(?:status|error|check):\s+/i.test(line),
  );
  if (statusLine) return statusLine;
  const semanticLine = lines.find((line) =>
    isMeaningfulProgressErrorLine(line),
  );
  return semanticLine ?? "Large unstructured error output omitted.";
}

function isMeaningfulProgressErrorLine(line: string): boolean {
  if (/^(?:at\s+|traceback\b|stack\b|\{|")/i.test(line)) return false;
  if (/^(?:debug|info|warn|warning|stderr|stdout|raw log):\s*/i.test(line))
    return false;
  if (/^Agent \S+:\s*\S+$/i.test(line)) return false;
  if (/^[\w.-]+:\d+:\d+/.test(line)) return false;
  return /[A-Za-z]/.test(line) && /\s/.test(line);
}

export interface DetailsProgress {
  lastToolPreview?: string;
  activityText?: string;
  activeToolActivity?: ToolActivity;
  progressLastToolPreview?: string;
  toolResultCompleted?: boolean;
  newToolCallIds: string[];
}

function trackNewToolCall(
  id: string,
  preview: string,
  seenToolCallIds: Set<string>,
  state: DetailsProgress,
): void {
  if (seenToolCallIds.has(id)) return;
  seenToolCallIds.add(id);
  state.newToolCallIds.push(id);
  state.lastToolPreview = preview;
}

function extractProgressFromExistingProgress(
  progress: {
    activityText?: string;
    activeToolActivity?: ToolActivity;
    lastToolPreview?: string;
    toolCalls: { id: string; preview: string }[];
    toolResultCompleted?: boolean;
  },
  seenToolCallIds: Set<string>,
  state: DetailsProgress,
): void {
  if (
    typeof progress.activityText === "string" &&
    progress.activityText.trim()
  ) {
    state.activityText = normalizeAndTruncate(progress.activityText);
  }
  if (progress.activeToolActivity) {
    state.activeToolActivity = progress.activeToolActivity;
  }
  if (
    typeof progress.lastToolPreview === "string" &&
    progress.lastToolPreview.trim()
  ) {
    state.progressLastToolPreview = normalizeAndTruncate(
      progress.lastToolPreview,
    );
  }
  if (progress.toolResultCompleted) {
    state.toolResultCompleted = true;
  }
  for (const toolCall of progress.toolCalls) {
    if (!isDerivedToolCall(toolCall)) continue;
    const preview = normalizeAndTruncate(toolCall.preview);
    trackNewToolCall(toolCall.id, preview, seenToolCallIds, state);
  }
}

function extractProgressFromMessages(
  messages: SingleResult["messages"] = [],
  seenToolCallIds: Set<string>,
  state: DetailsProgress,
): void {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (isToolCallPart(part)) {
        const preview = makeToolPreview(part.name, part.arguments);
        trackNewToolCall(part.id, preview, seenToolCallIds, state);
      }
    }
  }
}

export function extractProgressFromDetails(
  details: SubagentDetails,
  seenToolCallIds: Set<string>,
): DetailsProgress {
  const state: DetailsProgress = { newToolCallIds: [] };
  const results = Array.isArray(details.results) ? details.results : [];
  for (const result of results) {
    if (result.progress) {
      extractProgressFromExistingProgress(
        result.progress,
        seenToolCallIds,
        state,
      );
      continue;
    }
    const messages = Array.isArray(result.messages) ? result.messages : [];
    extractProgressFromMessages(messages, seenToolCallIds, state);
  }
  return state;
}

function isObjectWith(part: unknown): part is Record<string, unknown> {
  return typeof part === "object" && part !== null;
}

function isDerivedToolCall(part: unknown): part is {
  id: string;
  preview: string;
} {
  if (!isObjectWith(part)) return false;
  return typeof part.id === "string" && typeof part.preview === "string";
}

export function isToolCallPart(part: unknown): part is {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
} {
  if (!isObjectWith(part)) return false;
  return (
    part.type === "toolCall" &&
    typeof part.id === "string" &&
    typeof part.name === "string"
  );
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

export function formatContextPercent(state: SubagentProgressState): string {
  const d = state.contextWindowTokens;
  if (!d || d <= 0 || !Number.isFinite(d)) return "--%";
  const n = state.contextTokens;
  if (!n || n <= 0 || !Number.isFinite(n)) return "0%";
  return `${Math.round((n / d) * 100)}%`;
}

/**
 * Format the one-line statistics header for a subagent progress display.
 * Includes tool count, context window usage, and elapsed time.
 * When the subagent is still running (`durationMs` unset), elapsed is
 * computed live from `startTime`.
 *
 * @returns Single line ending in `\n`, e.g. `"3 tools · 45% ctx · 12.3s\n"`
 */
export function formatHeaderStats(state: SubagentProgressState): string {
  const elapsedMs = state.durationMs ?? Date.now() - state.startTime;
  const toolLabel = state.toolCount === 1 ? "tool" : "tools";
  return `${state.toolCount} ${toolLabel} · ${formatContextPercent(state)} ctx · ${formatElapsed(elapsedMs)}\n`;
}

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
