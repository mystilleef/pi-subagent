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
import { Box, Text } from "@earendil-works/pi-tui";
import { formatSubagentTitle, type SubagentTheme } from "../output/ui.js";
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

export { makeToolPreview } from "../output/normalize.js";
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
  getProgressState,
  makeTaskPreview,
  type ProgressStatus,
  patchProgressState,
  renderActivityStack,
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
    return renderProgressBox(state, this.options, this.theme).render(width);
  }
}

function getProgressBackground(status: ProgressStatus): ThemeBg {
  return STATUS_BG[status];
}

function renderProgressBox(
  state: SubagentProgressState,
  options: { expanded: boolean },
  theme: SubagentTheme,
): Box {
  const status = state.status;
  const title = formatSubagentTitle(state.agent, state.instanceName, theme);
  const header = `${theme.fg(STATUS_COLOR[status], STATUS_ICON[status])} ${title} ${theme.fg("dim", `[${status}]`)} ${theme.fg("muted", formatHeaderStats(state))}`;
  const box = new Box(1, 1, (line) =>
    theme.bg(getProgressBackground(status), line),
  );
  box.addChild(new Text(header, 0, 0));
  addProgressBody(box, state, options, theme);
  return box;
}

function addProgressBody(
  box: Box,
  state: SubagentProgressState,
  options: { expanded: boolean },
  theme: SubagentTheme,
): void {
  const body = makeProgressBody(state, options, theme);
  if (body.length === 0) return;
  for (const line of body) box.addChild(line);
}

function makeProgressBody(
  state: SubagentProgressState,
  options: { expanded: boolean },
  theme: SubagentTheme,
): Text[] {
  if (state.status === "running")
    return makeRunningProgressBody(state, options, theme);
  if (state.status === "error" || state.status === "cancelled") {
    return makeStoppedProgressBody(state, options, theme);
  }
  if (state.status === "success")
    return makeSuccessProgressBody(state, options, theme);
  return [];
}

function makeRunningProgressBody(
  state: SubagentProgressState,
  options: { expanded: boolean },
  theme: SubagentTheme,
): Text[] {
  const body: Text[] = [];
  if (state.lastToolPreview) {
    body.push(
      new Text(formatRunningToolPreview(state.lastToolPreview, theme), 2, 0),
    );
  }
  if (options.expanded)
    body.push(new Text(theme.fg("dim", state.taskPreview), 2, 0));
  return body;
}

function makeStoppedProgressBody(
  state: SubagentProgressState,
  options: { expanded: boolean },
  theme: SubagentTheme,
): Text[] {
  const body: Text[] = [];
  if (state.errorText)
    body.push(new Text(theme.fg("error", state.errorText), 2, 0));
  if (options.expanded)
    body.push(new Text(theme.fg("dim", state.taskPreview), 2, 0));
  return body;
}

function makeSuccessProgressBody(
  state: SubagentProgressState,
  options: { expanded: boolean },
  theme: SubagentTheme,
): Text[] {
  const output = state.finalOutput?.trim().split("\n")[0] ?? "";
  if (!options.expanded) {
    return output ? [new Text(theme.fg("toolOutput", output), 2, 0)] : [];
  }
  const body = [new Text(theme.fg("dim", state.taskPreview), 2, 0)];
  body.push(
    output
      ? new Text(
          `${theme.fg("muted", "─── Output ───")}\n${theme.fg("toolOutput", output)}`,
          0,
          0,
        )
      : new Text(theme.fg("muted", "(no output)"), 0, 0),
  );
  return body;
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
