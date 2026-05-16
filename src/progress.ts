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

import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import {
  formatHeaderStats,
  getProgressState,
  type ProgressStatus,
  STATUS_BG,
  STATUS_COLOR,
  STATUS_ICON,
  type SubagentProgressState,
  type ThemeBg,
} from "./progress-state.js";
import { formatSubagentTitle, type SubagentTheme } from "./ui.js";

export { makeToolPreview } from "./normalize.js";
export {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  formatContextPercent,
  formatElapsed,
  formatHeaderStats,
  formatTokenCount,
  getProgressState,
  makeTaskPreview,
  type ProgressStatus,
  patchProgressState,
  resetProgressStore,
  STATUS_COLOR,
  STATUS_ICON,
  type SubagentProgressState,
  type ThemeBg,
} from "./progress-state.js";

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
    const text = formatProgressText(state, this.options, this.theme);
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
  state: SubagentProgressState,
  options: { expanded: boolean },
  theme: SubagentTheme,
): string {
  const status = state.status;
  const title = formatSubagentTitle(state.agent, state.instanceName, theme);
  const header = `${theme.fg(STATUS_COLOR[status], STATUS_ICON[status])} ${title} ${theme.fg("dim", `[${status}]`)} ${theme.fg("muted", formatHeaderStats(state))}`;
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
