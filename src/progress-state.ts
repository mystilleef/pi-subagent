import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  isStatusOnlyFailure,
  isStatusOnlySuccess,
  makeToolPreview,
  normalizeSummaryValue,
  normalizeTerminalSentence,
  TOOL_PREVIEW_MAX_CHARS,
  truncateText,
} from "./normalize.js";
import type { SubagentDetails } from "./types.js";

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
  lastToolPreview?: string;
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
  instanceName = requestId,
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
      lastToolPreview: undefined,
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
    lastToolPreview: undefined,
  });
}

export function failProgressState(requestId: string, errorText: string): void {
  const sentence = deriveFailureTerminalSentence(errorText);
  storeTerminalProgressState(requestId, {
    status: "error",
    errorText: sentence,
    lastToolPreview: undefined,
  });
}

export function cancelProgressState(requestId: string, reason?: string): void {
  storeTerminalProgressState(requestId, {
    status: "cancelled",
    lastToolPreview: undefined,
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
  newToolCallIds: string[];
}

export function extractProgressFromDetails(
  details: SubagentDetails,
  seenToolCallIds: Set<string>,
): DetailsProgress {
  const newToolCallIds: string[] = [];
  let lastToolPreview: string | undefined;
  const results = Array.isArray(details.results) ? details.results : [];
  for (const result of results) {
    if (result.progress) {
      for (const toolCall of result.progress.toolCalls) {
        if (!isDerivedToolCall(toolCall)) continue;
        lastToolPreview = truncateText(
          normalizeSummaryValue(toolCall.preview),
          TOOL_PREVIEW_MAX_CHARS,
        );
        if (seenToolCallIds.has(toolCall.id)) continue;
        seenToolCallIds.add(toolCall.id);
        newToolCallIds.push(toolCall.id);
      }
      continue;
    }
    const messages = Array.isArray(result.messages) ? result.messages : [];
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (isToolCallPart(part)) {
          lastToolPreview = makeToolPreview(part.name, part.arguments);
          if (seenToolCallIds.has(part.id)) continue;
          seenToolCallIds.add(part.id);
          newToolCallIds.push(part.id);
        }
      }
    }
  }
  return { lastToolPreview, newToolCallIds };
}

function isDerivedToolCall(part: unknown): part is {
  id: string;
  preview: string;
} {
  if (typeof part !== "object" || part === null) return false;
  const maybe = part as { id?: unknown; preview?: unknown };
  return typeof maybe.id === "string" && typeof maybe.preview === "string";
}

export function isToolCallPart(part: unknown): part is {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
} {
  if (typeof part !== "object" || part === null) return false;
  const maybe = part as { type?: unknown; id?: unknown; name?: unknown };
  return (
    maybe.type === "toolCall" &&
    typeof maybe.id === "string" &&
    typeof maybe.name === "string"
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

/**
 * Format a raw token count for compact inline display.
 * Values below 1000 rendered as-is. Larger counts use `k`
 * or `M` suffixes with one decimal place, stripping trailing `.0`.
 */
export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  const unit = count >= 1_000_000 ? "M" : "k";
  const divisor = count >= 1_000_000 ? 1_000_000 : 1000;
  return `${trimTrailingZero((count / divisor).toFixed(1))}${unit}`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
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
