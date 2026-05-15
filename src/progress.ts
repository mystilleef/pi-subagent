/**
 * Subagent progress rendering and formatting.
 *
 * Aggregates progress-state management (re-exported from `progress-state.js`),
 * elapsed/token formatters, and the live TUI progress component that renders
 * subagent execution status inline in the parent agent's output stream.
 *
 * `renderSubagentProgress` hooks into the pi message pipeline. It produces a
 * `DynamicSubagentProgressText` component that re-reads the progress store on
 * each render tick, so updates from child process streaming appear instantly
 * without explicit message-passing.
 *
 * All progress state lives in the store managed by `progress-state.js`.
 * This module is purely presentational — it queries state and formats output.
 *
 * @module progress
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import {
  getProgressState,
  type ProgressStatus,
  type SubagentProgressState,
} from "./progress-state.js";
import type { SubagentTheme, ThemeBg } from "./ui.js";

const STATUS_COLOR: Record<ProgressStatus, ThemeColor> = {
  success: "success",
  error: "error",
  cancelled: "error",
  running: "accent",
};

const STATUS_ICON: Record<ProgressStatus, string> = {
  success: "✓",
  error: "✗",
  cancelled: "⊘",
  running: "⟳",
};

const STATUS_BG: Record<ProgressStatus, ThemeBg> = {
  success: "toolSuccessBg",
  error: "toolErrorBg",
  cancelled: "toolErrorBg",
  running: "toolPendingBg",
};

export { makeToolPreview } from "./normalize.js";
export {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  makeTaskPreview,
  type ProgressStatus,
  patchProgressState,
  resetProgressStore,
  type SubagentProgressState,
} from "./progress-state.js";

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

function formatContextPercent(state: SubagentProgressState): string {
  const d = state.contextWindowTokens;
  if (!d || d <= 0 || !Number.isFinite(d)) return "--%";
  const n = state.contextTokens;
  if (!n || n <= 0 || !Number.isFinite(n)) return "0%";
  return `${Math.round((n / d) * 100)}%`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/**
 * Create a live-updating TUI progress component from a pi message.
 *
 * Called by the pi message renderer for messages with a `requestId` in
 * their `details`. Returns `undefined` when no progress state exists for
 * the request (e.g. before streaming starts or after cleanup).
 *
 * The returned `DynamicSubagentProgressText` component re-reads the
 * progress store on every render tick, so tool counts, context usage,
 * and output update in real time as the child process streams.
 *
 * @param message  - A pi message object. Must carry `details.requestId`.
 * @param options  - `expanded` controls whether the collapsed or full
 *                    progress view is rendered.
 * @param theme    - Subagent color theme for styling the output.
 * @returns A dynamic TUI component, or `undefined` if no active state.
 */
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
  return STATUS_BG[status];
}

function formatProgressText(
  requestId: string,
  options: { expanded: boolean },
  theme: SubagentTheme,
): string | undefined {
  const state = getProgressState(requestId);
  if (!state) return undefined;
  const status = state.status;
  const title = `${state.agent} ${state.instanceName}`;
  const header = `${theme.fg(STATUS_COLOR[status], STATUS_ICON[status])} ${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("dim", `[${status}]`)} ${theme.fg("muted", formatHeaderStats(state))}`;
  if (status === "running") {
    const toolLine = state.lastToolPreview
      ? `\n  ${formatRunningToolPreview(state.lastToolPreview, theme)}`
      : "";
    const taskLine = options.expanded
      ? `\n  ${theme.fg("dim", state.taskPreview)}`
      : "";
    return header + toolLine + taskLine;
  }
  if (status === "error" || status === "cancelled") {
    const errorLine = state.errorText
      ? `\n  ${theme.fg("error", state.errorText)}`
      : "";
    const taskLine = options.expanded
      ? `\n  ${theme.fg("dim", state.taskPreview)}`
      : "";
    return header + errorLine + taskLine;
  }
  if (status === "success") {
    const output = state.finalOutput?.trim().split("\n")[0] ?? "";
    if (!options.expanded) {
      return output ? `${header}\n  ${theme.fg("toolOutput", output)}` : header;
    }
    const outputSection = output
      ? `\n${theme.fg("muted", "─── Output ───")}\n${theme.fg("toolOutput", output)}`
      : `\n${theme.fg("muted", "(no output)")}`;
    return `${header}\n  ${theme.fg("dim", state.taskPreview)}${outputSection}`;
  }
  return header;
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
