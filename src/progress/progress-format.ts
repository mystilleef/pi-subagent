/**
 * Formatting and rendering helpers for subagent progress display.
 *
 * Pure presentation logic extracted from progress-state.js. No state
 * management or store access — only transforms data into display strings.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { normalizeAndTruncate } from "../output/normalize.js";
import type {
  AgentUsageRollup,
  StatusCounts,
  ToolActivity,
  UsageInstanceNode,
} from "../shared/types.js";
import {
  combineRollups,
  computeSubtreeRollup,
} from "../shared/usage-accounting.js";
import { serializeUsageSnapshot } from "../shared/usage-snapshot.js";
import { isSafePositiveInteger } from "../shared/usage-validation.js";
import {
  type ProgressStatus,
  STATUS_COUNT_ORDER,
  STATUS_ICON,
  type SubagentProgressState,
} from "./progress-state.js";

export const SENSITIVE_PATTERN = /secret|token|password/i;

export const REDACTED_PLACEHOLDER = "(running...)";

/** Ordinals render from #2; one-off instances keep their plain title. */
function isDisplayOrdinal(ordinal: number | undefined): ordinal is number {
  return isSafePositiveInteger(ordinal) && ordinal >= 2;
}

/**
 * Role-tagged piece of the display-only activity line. Every role except
 * `plain` names a semantic style, so literal `\u2026`, `\u203a`, or `(hidden)` text
 * inside a tool or target never takes another piece's role.
 */
export interface ActivityDisplayPiece {
  role:
    | "plain"
    | "mark"
    | "agent"
    | "ordinal"
    | "instance"
    | "tool"
    | "target"
    | "inferred";
  text: string;
}

export const SPACE: ActivityDisplayPiece = { role: "plain", text: " " };

/**
 * Identity shared by every surface: `<base> <name>`, with `#<n>` inserted
 * only for valid ordinals `n >= 2`. Unnamed instances fall back to base.
 */
export function identityPieces(
  base: string,
  instanceName: string | undefined,
  ordinal: number | undefined,
): ActivityDisplayPiece[] {
  const pieces: ActivityDisplayPiece[] = [{ role: "agent", text: base }];
  if (!instanceName) return pieces;
  if (isDisplayOrdinal(ordinal))
    pieces.push(SPACE, { role: "ordinal", text: `#${ordinal}` });
  pieces.push(SPACE, { role: "instance", text: instanceName });
  return pieces;
}

/**
 * Identity label for titles, trees, and stored activity text.
 * `styleOrdinal` lets themed titles color the ordinal segment.
 */
export function formatDisplayIdentity(
  base: string,
  instanceName: string | undefined,
  ordinal?: number,
  styleOrdinal: (text: string) => string = (text) => text,
): string {
  return identityPieces(base, instanceName, ordinal)
    .map((piece) =>
      piece.role === "ordinal" ? styleOrdinal(piece.text) : piece.text,
    )
    .join("");
}

/**
 * Format a millisecond duration for compact display.
 * Renders sub-minute durations as decimal seconds (`45.2s`),
 * longer durations as minutes and whole seconds (`2m 15s`).
 *
 * Settled precision: terminal durations, result headers, `/stats`
 * aggregates, and notifications keep tenths below one minute.
 */
export function formatElapsed(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Format a running duration: whole seconds below one minute, since tenths
 * flicker on every render; `formatElapsed` above. Non-finite and
 * non-positive inputs (clock skew) render `0s`.
 */
export function formatLiveElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return formatElapsed(ms);
}

/** Context window fields shared by progress states and usage stats. */
interface ContextUsage {
  contextTokens?: number | undefined;
  contextWindowTokens?: number | undefined;
}

export function formatContextPercent(state: ContextUsage): string {
  const windowTokens = state.contextWindowTokens;
  if (!windowTokens || windowTokens <= 0 || !Number.isFinite(windowTokens))
    return "--%";
  const usedTokens = state.contextTokens;
  if (!usedTokens || usedTokens <= 0 || !Number.isFinite(usedTokens))
    return "0%";
  return `${Math.round((usedTokens / windowTokens) * 100)}%`;
}

/**
 * Format the one-line activity statistics every status card header shows:
 * tool count, context window usage, and elapsed time.
 *
 * Settled by default (`formatElapsed` tenths); pass `{ live: true }` for
 * running headers (`formatLiveElapsed` floored whole seconds).
 *
 * @returns Single line, e.g. `"3 tools · 45% ctx · 12.3s"`
 */
export function formatActivityStats(
  toolCount: number,
  context: ContextUsage,
  elapsedMs: number,
  options?: { live?: boolean | undefined },
): string {
  const toolLabel = toolCount === 1 ? "tool" : "tools";
  return [
    `${toolCount} ${toolLabel}`,
    `${formatContextPercent(context)} ctx`,
    options?.live ? formatLiveElapsed(elapsedMs) : formatElapsed(elapsedMs),
  ].join(SEGMENT_SEPARATOR);
}

/**
 * Format the activity statistics for a subagent progress state. When the
 * subagent is still running (`durationMs` unset), elapsed is computed live
 * from `startTime` with floored whole-second precision; settled states keep
 * tenths.
 */
export function formatHeaderStats(state: SubagentProgressState): string {
  return formatActivityStats(
    state.toolCount,
    state,
    state.durationMs ?? Date.now() - state.startTime,
    { live: state.durationMs === undefined },
  );
}

/**
 * Renders a ToolActivity tree for storage. Each segment is
 * independently normalized and truncated to TOOL_PREVIEW_MAX_CHARS (120).
 */
export function renderToolActivity(
  activity: ToolActivity | undefined,
): string | undefined {
  if (!activity) return undefined;
  const parts: string[] = [];
  for (let node: ToolActivity | undefined = activity; node; node = node.child) {
    if (node.inputSummary)
      parts.push(
        normalizeAndTruncate(
          formatDisplayIdentity(
            node.inputSummary,
            node.instanceName,
            node.ordinal,
          ),
        ),
      );
  }
  if (parts.length === 0) return activity.toolName;
  const result = parts.join(" - ");
  if (SENSITIVE_PATTERN.test(result)) return REDACTED_PLACEHOLDER;
  return result;
}

/** Separator between inline display segments on cards, footers, and boards. */
export const SEGMENT_SEPARATOR = " \u00b7 ";

function isUsableTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Formats a cost with the four decimals every card and board uses. */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/** True when the node holds retained or omitted descendants. */
export function hasDescendants(node: UsageInstanceNode): boolean {
  return node.children.length > 0 || (node.omitted?.count ?? 0) > 0;
}

function computeDescendantRollup(root: UsageInstanceNode) {
  const parts = root.children.map(computeSubtreeRollup);
  if (root.omitted) parts.push(root.omitted.totals);
  return combineRollups(parts);
}

function collectLatestStartedAt(root: UsageInstanceNode): Map<string, number> {
  const latest = new Map<string, number>();
  const visit = (node: UsageInstanceNode): void => {
    for (const child of node.children) {
      if (isUsableTimestamp(child.startedAt)) {
        const prior = latest.get(child.agent);
        if (prior === undefined || child.startedAt > prior) {
          latest.set(child.agent, child.startedAt);
        }
      }
      visit(child);
    }
  };
  visit(root);
  return latest;
}

function groupTier(statuses: StatusCounts): 0 | 1 | 2 {
  if (statuses.running > 0) return 0;
  if (statuses.error > 0 || statuses.cancelled > 0) return 1;
  return 2;
}

/** Glyph-first count (`✓3`), matching header, tree, and token prefixes. */
export function formatStatusCount(
  status: ProgressStatus,
  count: number,
): string {
  return `${STATUS_ICON[status]}${count}`;
}

function formatAgentGroup(agent: string, entry: AgentUsageRollup): string {
  const present = STATUS_COUNT_ORDER.filter(
    (status) => entry.statuses[status] > 0,
  );
  const [only] = present;
  if (present.length === 1 && only !== undefined) {
    return `${agent} ${formatStatusCount(only, entry.instances)}`;
  }
  const inner = present
    .map((status) => formatStatusCount(status, entry.statuses[status]))
    .join(" ");
  return `${agent} ${entry.instances} (${inner})`;
}

export interface DescendantTallyOptions {
  /** Appends `run $<total>`; `/stats` passes false, its header already shows subtree cost. */
  includeRunCost?: boolean | undefined;
}

/**
 * Format the descendant tally for a usage subtree.
 *
 * Aggregates every descendant depth, excludes self, includes omitted
 * totals exactly once, and orders groups by tier then recency. Recency
 * uses every retained descendant in the accounting source, never only
 * tree-visible nodes. Cost-bearing tallies end with four-decimal
 * whole-subtree `run $<total>` including self and omitted totals exactly
 * once. Reserves the run suffix while fitting groups, collapsing trailing
 * groups into `+<K> more` before the suffix. Returns undefined for leaves
 * or when prefix, required omission marker, and applicable suffix cannot fit.
 */
export function formatDescendantTally(
  root: UsageInstanceNode,
  contentWidth: number,
  options?: DescendantTallyOptions,
): string | undefined {
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return undefined;
  if (!hasDescendants(root)) return undefined;
  const includeRun = options?.includeRunCost ?? true;
  const rollup = computeDescendantRollup(root);
  const prefix = `${rollup.instances} spawned`;
  const runSuffix = includeRun
    ? `run ${formatCost(computeSubtreeRollup(root).usage.cost)}`
    : undefined;
  const latestByAgent = collectLatestStartedAt(root);
  const ordered = Object.entries(rollup.byAgent)
    .map(([agent, entry]) => ({
      agent,
      entry,
      tier: groupTier(entry.statuses),
      // Usable timestamps are nonnegative, so undated agents sort last.
      latest: latestByAgent.get(agent) ?? -1,
    }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.latest - a.latest ||
        a.agent.localeCompare(b.agent),
    )
    .map(({ agent, entry }) => formatAgentGroup(agent, entry));
  for (let hidden = 0; hidden <= ordered.length; hidden += 1) {
    const segments = [prefix, ...ordered.slice(0, ordered.length - hidden)];
    if (hidden > 0) segments.push(`+${hidden} more`);
    if (runSuffix) segments.push(runSuffix);
    const candidate = segments.join(SEGMENT_SEPARATOR);
    if (visibleWidth(candidate) <= contentWidth) return candidate;
  }
  return undefined;
}

export interface FormatUsageTreeOptions {
  includeRoot?: boolean | undefined;
  now?: number | undefined;
  /** Appends each node's self cost, as `/stats <run>` shows. */
  showCost?: boolean | undefined;
}

function formatTreeNodeDuration(
  node: UsageInstanceNode,
  now: number,
): string | undefined {
  if (node.status === "running") {
    const elapsed =
      isUsableTimestamp(node.startedAt) && Number.isFinite(now)
        ? Math.max(0, now - node.startedAt)
        : 0;
    return formatLiveElapsed(elapsed);
  }
  return node.durationMs !== undefined && isUsableTimestamp(node.durationMs)
    ? formatElapsed(node.durationMs)
    : undefined;
}

function sortTreeChildren(children: UsageInstanceNode[]): UsageInstanceNode[] {
  return [...children].sort(
    (a, b) =>
      a.startedAt - b.startedAt ||
      a.agent.localeCompare(b.agent) ||
      a.instanceName.localeCompare(b.instanceName) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Format bounded usage-tree lines.
 *
 * Bounds the tree to the 50-node snapshot contract (root included), so
 * omitted rollups keep totals exact. Descendants-only hides the root line
 * but still counts it toward the bound. Siblings sort by ascending
 * `startedAt`; omitted descendants render as `+<count> earlier` at child
 * indent.
 */
export function formatUsageTree(
  root: UsageInstanceNode,
  options?: FormatUsageTreeOptions,
): string[] {
  const now = options?.now ?? Date.now();
  const lines: string[] = [];
  const renderChildren = (node: UsageInstanceNode, depth: number): void => {
    for (const child of sortTreeChildren(node.children)) {
      renderNode(child, depth);
    }
    if (node.omitted && node.omitted.count > 0) {
      lines.push(`${"  ".repeat(depth)}+${node.omitted.count} earlier`);
    }
  };
  const renderNode = (node: UsageInstanceNode, depth: number): void => {
    const identity = formatDisplayIdentity(
      node.agent,
      node.instanceName,
      node.ordinal,
    );
    const parts = [
      `${"  ".repeat(depth)}${STATUS_ICON[node.status]} ${identity}`,
    ];
    const duration = formatTreeNodeDuration(node, now);
    if (duration) parts.push(duration);
    if (options?.showCost) parts.push(formatCost(node.usage.cost));
    lines.push(parts.join(SEGMENT_SEPARATOR));
    renderChildren(node, depth + 1);
  };
  const bounded = serializeUsageSnapshot(root);
  if (options?.includeRoot) renderNode(bounded, 0);
  else renderChildren(bounded, 0);
  return lines;
}
