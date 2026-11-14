import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { formatCost, formatHeaderStats } from "../progress/progress-format.js";
import type {
  ProgressStatus,
  SubagentProgressState,
} from "../progress/progress-state.js";
import type {
  SessionUsageQueryResult,
  UsageInstanceNode,
} from "../shared/types.js";
import { style } from "./semantic-style.js";
import {
  createDescendantTally,
  formatSessionHeader,
  formatSubagentTitle,
  makeSectionHeader,
  plural,
  renderStatusCard,
  type StatusCardOptions,
  type SubagentTheme,
} from "./ui.js";

const BODY_PREVIEW_MAX = 120;

function selectRunsBoardBody(state: SubagentProgressState): string {
  return (
    [state.finalOutput, state.errorText, state.taskPreview].find(
      (c): c is string => typeof c === "string" && c.trim().length > 0,
    ) ?? ""
  );
}

function renderJobCard(
  state: SubagentProgressState,
  theme: SubagentTheme,
  usageInstance?: UsageInstanceNode,
): Box {
  const title = formatSubagentTitle(
    state.agent,
    state.instanceName,
    theme,
    state.ordinal,
  );
  const bodyText = selectRunsBoardBody(state);
  const preview =
    bodyText.length > BODY_PREVIEW_MAX
      ? `${bodyText.slice(0, BODY_PREVIEW_MAX - 1)}…`
      : bodyText;
  const options: StatusCardOptions = {
    status: state.status,
    title,
    variant: "abridged",
    metadata: formatHeaderStats(state),
    body: preview,
  };
  // A running subtree's cost stays partial; only settled jobs report it.
  const tally = createDescendantTally(usageInstance, theme, {
    includeRunCost: state.status !== "running",
  });
  if (tally) options.tally = tally;
  if (state.modelDisplay) options.footer = state.modelDisplay;
  return renderStatusCard(options, theme);
}

/** Ledger data the `/jobs` board renders beside progress state. */
export interface RunsBoardUsage {
  session: SessionUsageQueryResult;
  /** Ledger subtree per job `requestId`; jobs without one show no run cost. */
  instances: ReadonlyMap<string, UsageInstanceNode>;
}

function sortByStartTimeDesc(
  a: SubagentProgressState,
  b: SubagentProgressState,
): number {
  return b.startTime - a.startTime;
}

/** Ordered section definitions: label → status filter for the runs board. */
const BOARD_SECTIONS: [string, ProgressStatus][] = [
  ["ACTIVE", "running"],
  ["FAILED", "error"],
  ["CANCELLED", "cancelled"],
  ["SUCCEEDED", "success"],
];

// Jobs render in status-specific sections, each sorted by `startTime` descending.
// Status icons preserve the existing /jobs contract for running and cancelled jobs.
export function renderRunsBoard(
  states: SubagentProgressState[],
  theme: SubagentTheme,
  width = 80,
  usage?: RunsBoardUsage,
): Component {
  if (states.length === 0) {
    return new Text(
      style(theme, "boardText", "No /run jobs in this session."),
      0,
      0,
    );
  }
  const grouped = new Map<ProgressStatus, SubagentProgressState[]>();
  for (const s of states) {
    const bucket = grouped.get(s.status);
    if (bucket) bucket.push(s);
    else grouped.set(s.status, [s]);
  }
  for (const bucket of grouped.values()) bucket.sort(sortByStartTimeDesc);
  const box = new Box(0, 0);
  if (usage) {
    const { runs, rollup } = usage.session;
    const header = formatSessionHeader(
      theme,
      plural(runs.length, "run"),
      plural(rollup.instances, "instance"),
      formatCost(rollup.usage.cost),
    );
    box.addChild(new Text(header, 0, 0));
  }
  const addSection = (
    label: string,
    sectionStates: SubagentProgressState[],
  ) => {
    if (sectionStates.length === 0) return;
    box.addChild(makeSectionHeader(label, sectionStates.length, width, theme));
    for (const state of sectionStates)
      box.addChild(
        renderJobCard(state, theme, usage?.instances.get(state.requestId)),
      );
  };
  for (const [label, status] of BOARD_SECTIONS)
    addSection(label, grouped.get(status) ?? []);
  return box;
}
