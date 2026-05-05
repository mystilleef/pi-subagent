import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";
import type { SubagentDetails } from "./types.js";
import type { SubagentTheme, ThemeBg } from "./ui.js";

export type ProgressStatus = "running" | "success" | "error" | "cancelled";

export interface SubagentProgressState {
  requestId: string;
  agent: string;
  taskPreview: string;
  status: ProgressStatus;
  startTime: number;
  lastToolName?: string;
  lastToolPreview?: string;
  toolCount: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  cost?: number;
  finalOutput?: string;
  errorText?: string;
}

const TERMINAL_TEXT_MAX_LEN = 500;
const ERROR_STATE_MAX_LEN = 280;
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

export function finalizeProgressState(
  requestId: string,
  finalOutput: string,
): void {
  patchProgressState(requestId, {
    status: "success",
    finalOutput: makeTerminalTextPreview(finalOutput),
    lastToolName: undefined,
    lastToolPreview: undefined,
  });
}

export function failProgressState(requestId: string, errorText: string): void {
  patchProgressState(requestId, {
    status: "error",
    errorText: makeTerminalTextPreview(errorText, ERROR_STATE_MAX_LEN),
    lastToolName: undefined,
    lastToolPreview: undefined,
  });
}

export function cancelProgressState(requestId: string, reason?: string): void {
  patchProgressState(requestId, {
    status: "cancelled",
    lastToolName: undefined,
    lastToolPreview: undefined,
    ...(reason !== undefined
      ? { errorText: makeTerminalTextPreview(reason, ERROR_STATE_MAX_LEN) }
      : {}),
  });
}

export function clearProgressState(requestId: string): void {
  store.delete(requestId);
}

export function makeTaskPreview(task: string, maxLen = 80): string {
  const flat = task.replace(/\s+/g, " ").trim();
  if (!flat) return "(agent default)";
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen)}...`;
}

export interface DetailsProgress {
  lastToolName?: string;
  lastToolPreview?: string;
  newToolCallIds: string[];
}

export function extractProgressFromDetails(
  details: SubagentDetails,
  seenToolCallIds: Set<string>,
): DetailsProgress {
  const newToolCallIds: string[] = [];
  let lastToolName: string | undefined;
  let lastToolPreview: string | undefined;
  const results = Array.isArray(details.results) ? details.results : [];
  for (const result of results) {
    const messages = Array.isArray(result.messages) ? result.messages : [];
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (!isToolCallPart(part)) continue;
        lastToolName = part.name;
        lastToolPreview = makeToolPreview(part.name, part.arguments);
        if (seenToolCallIds.has(part.id)) continue;
        seenToolCallIds.add(part.id);
        newToolCallIds.push(part.id);
      }
    }
  }
  return {
    lastToolName,
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
  maxArgLen = 60,
): string {
  if (!args) return toolName;
  const values = Object.values(args);
  if (values.length === 0) return toolName;
  const first = formatToolArgValue(values[0]);
  if (first.length <= maxArgLen) return `${toolName}: ${first}`;
  return `${toolName}: ${first.slice(0, maxArgLen)}...`;
}

function formatToolArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function makeTerminalTextPreview(
  text: string,
  maxLen = TERMINAL_TEXT_MAX_LEN,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}...`;
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

export function formatCost(cost: number): string {
  return `$${cost.toFixed(cost >= 0.01 ? 2 : 4)}`;
}

export function formatHeaderStats(state: SubagentProgressState): string {
  const segments = [
    `${state.toolCount} ${state.toolCount === 1 ? "tool" : "tools"}`,
  ];
  if (state.turns && state.turns > 0)
    segments.push(`${state.turns} ${state.turns === 1 ? "turn" : "turns"}`);
  if (state.contextTokens && state.contextTokens > 0)
    segments.push(`${formatTokenCount(state.contextTokens)} ctx`);
  if (
    (state.inputTokens && state.inputTokens > 0) ||
    (state.outputTokens && state.outputTokens > 0)
  )
    segments.push(
      `${formatTokenCount(state.inputTokens ?? 0)} in / ${formatTokenCount(state.outputTokens ?? 0)} out`,
    );
  const cacheTokens =
    (state.cacheReadTokens ?? 0) + (state.cacheWriteTokens ?? 0);
  if (cacheTokens > 0) segments.push(`${formatTokenCount(cacheTokens)} cache`);
  if (state.cost && state.cost > 0) segments.push(formatCost(state.cost));
  return segments.join(" · ");
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
      ? new Text(text, 0, 0, (line) => this.theme.bg(bg, line)).render(width)
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
  const elapsed = formatElapsed(Date.now() - state.startTime);
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
    theme.fg("muted", `${elapsed} · ${headerStats}`);
  const taskLine = `\n  ${theme.fg("dim", state.taskPreview)}`;
  if (state.status === "running") {
    const toolLine = state.lastToolPreview
      ? `\n  ${theme.fg("dim", `→ ${state.lastToolPreview}`)}`
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
    const output = state.finalOutput?.trim() ?? "";
    if (!options.expanded) {
      const preview = output
        ? `\n  ${theme.fg("toolOutput", output.split("\n")[0] ?? "")}`
        : "";
      return header + preview;
    }
    const outputSection = output
      ? `\n${theme.fg("muted", "─── Output ───")}\n${theme.fg("toolOutput", output)}`
      : `\n${theme.fg("muted", "(no output)")}`;
    return header + taskLine + outputSection;
  }
  return header;
}
