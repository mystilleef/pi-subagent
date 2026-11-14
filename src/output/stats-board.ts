import { Box, type Component, Text } from "@earendil-works/pi-tui";
import {
  formatCost,
  formatDisplayIdentity,
  formatElapsed,
  formatStatusCount,
  formatUsageTree,
} from "../progress/progress-format.js";
import { STATUS_COUNT_ORDER } from "../progress/progress-state.js";
import type {
  AccountingRollup,
  AdditiveUsage,
  StatusCounts,
  UsageInstanceNode,
} from "../shared/types.js";
import { computeSubtreeRollup } from "../shared/usage-accounting.js";
import {
  createDescendantTally,
  formatSubagentTitle,
  formatTokens,
  joinSegments,
  makeSectionHeader,
  plural,
  renderCard,
  type SubagentTheme,
} from "./ui.js";

// Mirrors result footers' compact counts; cache parts appear only when
// nonzero because most runs never write cache.
function formatUsageTokens(usage: AdditiveUsage): string {
  const parts = [
    `↑${formatTokens(usage.input)}`,
    `↓${formatTokens(usage.output)}`,
  ];
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  return parts.join(" ");
}

function formatStatusCounts(statuses: StatusCounts): string {
  return STATUS_COUNT_ORDER.map((status) =>
    formatStatusCount(status, statuses[status]),
  ).join(" ");
}

function renderStatsRunCard(run: UsageInstanceNode, theme: SubagentTheme): Box {
  const rollup = computeSubtreeRollup(run);
  const title = formatSubagentTitle(
    run.agent,
    run.instanceName,
    theme,
    run.ordinal,
  );
  const totals = joinSegments(
    formatUsageTokens(rollup.usage),
    formatCost(rollup.usage.cost),
  );
  return renderCard(
    {
      status: run.status,
      title,
      metadata: totals,
      blocks: [createDescendantTally(run, theme, { includeRunCost: false })],
    },
    theme,
  );
}

/**
 * Styled session statistics board: session header, per-agent rows, and
 * recent-first run summaries. Follows the /jobs board pattern with one
 * display/notification rendering path.
 */
export function renderStatsBoard(
  runs: UsageInstanceNode[],
  rollup: AccountingRollup,
  theme: SubagentTheme,
  width = 80,
): Component {
  const box = new Box(0, 0);
  const sessionHeader = joinSegments(
    "Session",
    plural(runs.length, "run"),
    plural(rollup.instances, "instance"),
    formatUsageTokens(rollup.usage),
    formatCost(rollup.usage.cost),
  );
  box.addChild(new Text(theme.fg("muted", sessionHeader), 0, 0));
  const agents = Object.entries(rollup.byAgent).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const nameWidth = Math.max(...agents.map(([agent]) => agent.length));
  for (const [agent, stats] of agents) {
    const row = joinSegments(
      `${agent.padEnd(nameWidth)} ${stats.instances}`,
      formatStatusCounts(stats.statuses),
      formatUsageTokens(stats.usage),
      formatCost(stats.usage.cost),
      formatElapsed(stats.durationMs),
    );
    box.addChild(new Text(theme.fg("muted", row), 0, 0));
  }
  box.addChild(makeSectionHeader("RUNS", runs.length, width, theme));
  for (const run of runs) box.addChild(renderStatsRunCard(run, theme));
  return box;
}

/**
 * Styled run statistics board: exact header totals plus root-inclusive
 * bounded tree. Follows the /jobs board pattern with one
 * display/notification rendering path.
 */
export function renderStatsRunBoard(
  run: UsageInstanceNode,
  rollup: AccountingRollup,
  theme: SubagentTheme,
  now = Date.now(),
): Component {
  // The root's own duration is the run's wall-clock time; summed instance
  // durations overstate it whenever children run in parallel.
  const header = joinSegments(
    `${formatDisplayIdentity(run.agent, run.instanceName, run.ordinal)} (${run.id})`,
    plural(rollup.instances, "instance"),
    formatStatusCounts(rollup.statuses),
    formatUsageTokens(rollup.usage),
    formatCost(rollup.usage.cost),
    run.durationMs !== undefined ? formatElapsed(run.durationMs) : undefined,
  );
  const box = new Box(0, 0);
  box.addChild(new Text(theme.fg("muted", header), 0, 0));
  const tree = formatUsageTree(run, { includeRoot: true, now, showCost: true });
  for (const line of tree)
    box.addChild(new Text(theme.fg("muted", line), 0, 0));
  return box;
}
