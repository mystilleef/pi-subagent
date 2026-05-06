import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";
import {
  extractSemanticToolTarget,
  filterOutputLines,
  normalizeSummaryValue,
} from "./normalize.js";
import type { SubagentDetails } from "./types.js";
import type { SubagentTheme, ThemeBg } from "./ui.js";

export type ProgressStatus = "running" | "success" | "error" | "cancelled";

export interface SubagentProgressState {
  requestId: string;
  agent: string;
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

const TOOL_PREVIEW_MAX_CHARS = 120;
const TERMINAL_SENTENCE_MAX_CHARS = 160;
const store = new Map<string, SubagentProgressState>();

export function createProgressState(
  requestId: string,
  agent: string,
  task: string,
): void {
  store.set(requestId, {
    requestId,
    agent,
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

export function patchProgressState(
  requestId: string,
  patch: Partial<SubagentProgressState>,
): void {
  const state = store.get(requestId);
  if (!state) return;
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
  const sentence = _deriveFailureTerminalSentence(errorText);
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
      ? { errorText: _deriveAmbiguousTerminalSentence(reason) }
      : {}),
  });
}

export function clearProgressState(requestId: string): void {
  store.delete(requestId);
}

export function makeTaskPreview(task: string): string {
  const flat = normalizeSummaryValue(task);
  return flat || "(agent default)";
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
    const messages = Array.isArray(result.messages) ? result.messages : [];
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (!isToolCallPart(part)) continue;
        lastToolPreview = makeToolPreview(part.name, part.arguments);
        if (seenToolCallIds.has(part.id)) continue;
        seenToolCallIds.add(part.id);
        newToolCallIds.push(part.id);
      }
    }
  }
  return {
    lastToolPreview,
    newToolCallIds,
  };
}

function isToolCallPart(part: unknown): part is {
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

export function makeToolPreview(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args || Object.keys(args).length === 0) return toolName;
  const target = extractSemanticToolTarget(toolName, args);
  if (!target) return toolName;
  return truncateToolPreview(`${toolName}: ${target}`);
}

function truncateToolPreview(preview: string): string {
  const characters = Array.from(preview);
  if (characters.length <= TOOL_PREVIEW_MAX_CHARS) return preview;
  return `${characters.slice(0, TOOL_PREVIEW_MAX_CHARS - 1).join("")}…`;
}

function formatRunningToolPreview(
  preview: string,
  theme: SubagentTheme,
): string {
  const separatorIndex = preview.indexOf(":");
  const arrow = theme.fg("muted", "→");
  if (separatorIndex === -1) return `${arrow} ${theme.fg("accent", preview)}`;
  const toolName = preview.slice(0, separatorIndex);
  const rest = preview.slice(separatorIndex);
  return `${arrow} ${theme.fg("accent", toolName)}${theme.fg("dim", rest)}`;
}

function makeProgressFinalOutput(finalOutput: string): string {
  return _deriveSuccessTerminalSentence(finalOutput);
}

function _deriveSuccessTerminalSentence(finalOutput: string): string {
  const lines = filterOutputLines(finalOutput)
    .map((line) => normalizeTerminalSentence(line))
    .filter(Boolean);
  const outcome = lines.find((line) => /^Outcome:\s*/i.test(line));
  const selected = outcome
    ? outcome.replace(/^Outcome:\s*/i, "")
    : (lines[0] ?? "");
  const normalized = normalizeTerminalSentence(selected);
  if (!normalized) return "";
  if (isStatusOnlySuccessTerminalSentence(normalized)) return "completed task";
  return normalized;
}

function _deriveFailureTerminalSentence(errorText: string): string {
  const source = extractProgressSemanticErrorLine(errorText);
  if (!source || source === "Large unstructured error output omitted.")
    return source;
  const normalized = normalizeTerminalSentence(source);
  if (!normalized || isStatusOnlyFailureTerminalSentence(normalized))
    return "task failed";
  return normalized;
}

function _deriveAmbiguousTerminalSentence(text: string): string {
  return normalizeTerminalSentence(text);
}

function normalizeTerminalSentence(value: string): string {
  const unwrapped = value
    .replace(/^\s*(?:[-*>]\s*)+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*`{1,3}([^`]+)`{1,3}\s*$/, "$1")
    .replace(/^\s*\*\*([^*]+)\*\*\s*$/, "$1")
    .replace(/^\s*__([^_]+)__\s*$/, "$1");
  const withoutStatusPrefix = stripTerminalStatusPrefixes(unwrapped);
  const withoutLabel = withoutStatusPrefix.replace(
    /^\s*(?:status|summary|result|output|message|error|check):\s+/i,
    "",
  );
  const collapsed = normalizeSummaryValue(withoutLabel)
    .replace(/\s+/g, " ")
    .trim();
  return truncateTerminalSentence(collapsed);
}

function stripTerminalStatusPrefixes(value: string): string {
  return value.replace(/^(?:(?:success|failure):\s*)+/i, "");
}

function isStatusOnlySuccessTerminalSentence(value: string): boolean {
  return /^(?:success|done)$/i.test(value.trim());
}

function isStatusOnlyFailureTerminalSentence(value: string): boolean {
  return /^(?:failure|failed|error)$/i.test(value.trim());
}

function truncateTerminalSentence(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= TERMINAL_SENTENCE_MAX_CHARS) return value;
  return `${characters.slice(0, TERMINAL_SENTENCE_MAX_CHARS - 1).join("")}…`;
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

export function formatElapsed(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  const unit = count >= 1_000_000 ? "M" : "k";
  const divisor = count >= 1_000_000 ? 1_000_000 : 1000;
  return `${trimTrailingZero((count / divisor).toFixed(1))}${unit}`;
}

export function formatHeaderStats(state: SubagentProgressState): string {
  const elapsedMs = state.durationMs ?? Date.now() - state.startTime;
  return `${[
    `${formatTokenCount(state.inputTokens ?? 0)} in`,
    `${formatTokenCount(state.outputTokens ?? 0)} out`,
    `${formatContextPercent(state)} ctx`,
    formatElapsed(elapsedMs),
  ].join(" · ")}\n`;
}

function formatContextPercent(state: SubagentProgressState): string {
  const denominator = state.contextWindowTokens;
  if (
    typeof denominator !== "number" ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  )
    return "--%";
  const numerator = state.contextTokens;
  if (
    typeof numerator !== "number" ||
    !Number.isFinite(numerator) ||
    numerator <= 0
  )
    return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

export function renderSubagentProgress(
  message: {
    customType?: string;
    content?: unknown;
    display?: boolean;
    details?: unknown;
  },
  options: { expanded: boolean },
  theme: SubagentTheme,
): Component | undefined {
  const details = message.details as { requestId?: string } | undefined;
  const requestId = details?.requestId;
  if (!requestId || !getProgressState(requestId)) return undefined;
  return new DynamicSubagentProgressText(requestId, options, theme);
}

class DynamicSubagentProgressText implements Component {
  constructor(
    private readonly requestId: string,
    private readonly options: { expanded: boolean },
    private readonly theme: SubagentTheme,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const state = getProgressState(this.requestId);
    if (!state) return [];
    const text = formatProgressText(this.requestId, this.options, this.theme);
    const bg = getProgressBackground(state.status);
    return text
      ? new Text(text, 1, 1, (line) => this.theme.bg(bg, line)).render(width)
      : [];
  }
}

function getProgressBackground(status: ProgressStatus): ThemeBg {
  if (status === "running") return "toolPendingBg";
  if (status === "success") return "toolSuccessBg";
  return "toolErrorBg";
}

function formatProgressText(
  requestId: string,
  options: { expanded: boolean },
  theme: SubagentTheme,
): string | undefined {
  const state = getProgressState(requestId);
  if (!state) return undefined;
  const statusColorMap: Record<ProgressStatus, ThemeColor> = {
    success: "success",
    error: "error",
    cancelled: "error",
    running: "accent",
  };
  const iconMap: Record<ProgressStatus, string> = {
    success: "✓",
    error: "✗",
    cancelled: "⊘",
    running: "⟳",
  };
  const statusColor = statusColorMap[state.status];
  const icon = iconMap[state.status];
  const headerStats = formatHeaderStats(state);
  const header =
    theme.fg(statusColor, icon) +
    " " +
    theme.fg("toolTitle", theme.bold(state.agent)) +
    " " +
    theme.fg("dim", `[${state.status}]`) +
    " " +
    theme.fg("muted", headerStats);
  const taskLine = `\n  ${theme.fg("dim", state.taskPreview)}`;
  if (state.status === "running") {
    const toolLine = state.lastToolPreview
      ? `\n  ${formatRunningToolPreview(state.lastToolPreview, theme)}`
      : "";
    return options.expanded ? header + toolLine + taskLine : header + toolLine;
  }
  if (state.status === "error" || state.status === "cancelled") {
    const errorLine = state.errorText
      ? `\n  ${theme.fg("error", state.errorText)}`
      : "";
    return options.expanded
      ? header + errorLine + taskLine
      : header + errorLine;
  }
  if (state.status === "success") {
    const output = state.finalOutput?.trim().split("\n")[0] ?? "";
    if (!options.expanded) {
      const preview = output ? `\n  ${theme.fg("toolOutput", output)}` : "";
      return header + preview;
    }
    const outputSection = output
      ? `\n${theme.fg("muted", "─── Output ───")}\n${theme.fg("toolOutput", output)}`
      : `\n${theme.fg("muted", "(no output)")}`;
    return header + taskLine + outputSection;
  }
  return header;
}
