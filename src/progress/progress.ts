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
import { queryInstanceUsage } from "../orchestration/usage-ledger.js";
import { style } from "../output/semantic-style.js";
import {
  CARD_BODY_INDENT,
  createDescendantTally,
  formatSubagentTitle,
  renderCard,
  type SubagentTheme,
} from "../output/ui.js";
import type { UsageInstanceNode } from "../shared/types.js";
import { renderToolActivityPieces } from "./activity-display.js";
import {
  type ActivityDisplayPiece,
  formatHeaderStats,
  formatUsageTree,
} from "./progress-format.js";
import {
  getProgressState,
  hasProgressResultPosted,
  type SubagentProgressState,
} from "./progress-state.js";

export { makeToolPreview } from "../output/normalize.js";
export {
  formatElapsed,
  formatHeaderStats,
  renderToolActivity,
} from "./progress-format.js";
export {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  hasProgressResultPosted,
  makeTaskPreview,
  markProgressResultPosted,
  patchProgressState,
  resetProgressStore,
  type SubagentProgressState,
} from "./progress-state.js";

/**
 * Create a live-updating TUI progress component from a pi message.
 *
 * Called by the pi message renderer for messages with a `requestId` in
 * their `details`. Always returns a component when `requestId` is present,
 * even when no progress state exists: the component renders zero lines
 * until state appears, and returns to zero lines once the terminal result
 * message has posted or state is gone. Returns `undefined` only for
 * messages without `requestId`, deferring to host default rendering
 * (e.g. project-agent collision notices).
 *
 * The returned `DynamicSubagentProgressText` component re-reads the
 * progress store on every render tick, so tool counts, context usage,
 * and output appear instantly as the child process streams, and so
 * already-created cards disappear promptly after result posting.
 *
 * Suppression never deletes stored state; `/jobs` and retained progress
 * state remain available. Terminal status alone never hides the card.
 *
 * @param message  - A pi message object. Must carry `details.requestId`.
 * @param options  - `expanded` controls whether the collapsed or full
 *                    progress view is rendered.
 * @param theme    - Subagent color theme for styling the output.
 * @returns A dynamic TUI component when `requestId` is present, else
 *   `undefined` for host default rendering.
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
  if (!requestId) return undefined;
  return new DynamicSubagentProgressText(requestId, options, theme);
}

class DynamicSubagentProgressText implements Component {
  private readonly requestId: string;
  private readonly options: { expanded: boolean };
  private readonly theme: SubagentTheme;
  constructor(
    requestId: string,
    options: { expanded: boolean },
    theme: SubagentTheme,
  ) {
    this.requestId = requestId;
    this.options = options;
    this.theme = theme;
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (hasProgressResultPosted(this.requestId)) return [];
    const state = getProgressState(this.requestId);
    if (!state) return [];
    return renderProgressBox(state, this.options, this.theme, width).render(
      width,
    );
  }
}

function renderProgressBox(
  state: SubagentProgressState,
  options: { expanded: boolean },
  theme: SubagentTheme,
  width: number,
): Box {
  const title = formatSubagentTitle(
    state.agent,
    state.instanceName,
    theme,
    state.ordinal,
  );
  const usage = queryInstanceUsage(state.requestId)?.instance;
  const expandedBlocks = options.expanded
    ? [
        new Text(
          `${style(theme, "taskLabel", "task:")} ${style(theme, "taskPreview", state.taskPreview)}`,
          CARD_BODY_INDENT,
          0,
        ),
        makeTreeBlock(usage, theme),
      ]
    : [];
  return renderCard(
    {
      status: state.status,
      title,
      metadata: formatHeaderStats(state),
      blocks: [
        makeProgressBodyBlock(state, theme, width),
        ...expandedBlocks,
        createDescendantTally(usage, theme, { includeRunCost: false }),
      ],
      footer: state.modelDisplay,
    },
    theme,
  );
}

/** Primary body shared by collapsed and expanded views; undefined when empty. */
function makeProgressBodyBlock(
  state: SubagentProgressState,
  theme: SubagentTheme,
  width: number,
): Text | undefined {
  if (state.status === "running")
    return makeRunningProgressBody(state, theme, width);
  if (state.status === "error" || state.status === "cancelled") {
    return makeStoppedProgressBody(state, theme);
  }
  if (state.status === "success") return makeSuccessProgressBody(state, theme);
  return undefined;
}

/** Descendant tree for expanded cards; undefined when absent. Rows stay contiguous. */
function makeTreeBlock(
  usage: UsageInstanceNode | undefined,
  theme: SubagentTheme,
): Box | undefined {
  if (!usage) return undefined;
  const lines = formatUsageTree(usage);
  if (lines.length === 0) return undefined;
  const tree = new Box(CARD_BODY_INDENT, 0);
  for (const line of lines)
    tree.addChild(new Text(style(theme, "tally", line), 0, 0));
  return tree;
}

function makeRunningProgressBody(
  state: SubagentProgressState,
  theme: SubagentTheme,
  width: number,
): Text | undefined {
  const pieces = renderToolActivityPieces(
    state.activeToolActivity,
    Math.max(0, width - 8),
  );
  if (pieces.length === 0) return undefined;
  return new Text(formatRunningActivity(pieces, theme), CARD_BODY_INDENT, 0);
}

function makeStoppedProgressBody(
  state: SubagentProgressState,
  theme: SubagentTheme,
): Text | undefined {
  if (!state.errorText) return undefined;
  return new Text(style(theme, "error", state.errorText), CARD_BODY_INDENT, 0);
}

function makeSuccessProgressBody(
  state: SubagentProgressState,
  theme: SubagentTheme,
): Text | undefined {
  const output = state.finalOutput?.trim().split("\n")[0] ?? "";
  if (!output) return undefined;
  return new Text(style(theme, "output", output), CARD_BODY_INDENT, 0);
}

/** Renders the activity row from role-tagged pieces; roles never come from text. */
function formatRunningActivity(
  pieces: ActivityDisplayPiece[],
  theme: SubagentTheme,
): string {
  const styled = pieces.map((piece) =>
    piece.role === "plain" ? piece.text : style(theme, piece.role, piece.text),
  );
  return `${style(theme, "mark", "→")} ${styled.join("")}`;
}
