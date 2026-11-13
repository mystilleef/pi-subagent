import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "../output/ui.js";
import { formatElapsed } from "../progress/progress-format.js";
import type {
  AccountingStatus,
  AdditiveUsage,
  StatusCounts,
  UsageInstanceNode,
} from "../shared/types.js";
import { queryRootRunUsage, querySessionUsage } from "./usage-ledger.js";

const STATUS_SYMBOLS: Record<AccountingStatus, string> = {
  success: "✓",
  error: "✗",
  cancelled: "⊘",
  running: "⟳",
};

const SEPARATOR = " · ";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

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
  return [
    `${STATUS_SYMBOLS.success}${statuses.success}`,
    `${STATUS_SYMBOLS.error}${statuses.error}`,
    `${STATUS_SYMBOLS.cancelled}${statuses.cancelled}`,
    `${STATUS_SYMBOLS.running}${statuses.running}`,
  ].join(" ");
}

function formatSessionStats(): string | undefined {
  const { runs, rollup } = querySessionUsage();
  if (runs.length === 0) return undefined;
  const lines = [
    [
      "Session",
      plural(runs.length, "run"),
      plural(rollup.instances, "instance"),
      formatUsageTokens(rollup.usage),
      formatCost(rollup.usage.cost),
    ].join(SEPARATOR),
  ];
  const agents = Object.entries(rollup.byAgent).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const nameWidth = Math.max(...agents.map(([agent]) => agent.length));
  for (const [agent, stats] of agents) {
    lines.push(
      [
        `${agent.padEnd(nameWidth)} ${stats.instances}`,
        formatStatusCounts(stats.statuses),
        formatUsageTokens(stats.usage),
        formatCost(stats.usage.cost),
        formatElapsed(stats.durationMs),
      ].join(SEPARATOR),
    );
  }
  return lines.join("\n");
}

function formatInstanceTreeLines(
  node: UsageInstanceNode,
  depth: number,
  lines: string[],
): void {
  const parts = [
    `${"  ".repeat(depth)}${STATUS_SYMBOLS[node.status]} ${node.agent} #${node.ordinal} ${node.instanceName}`,
  ];
  if (node.durationMs !== undefined) {
    parts.push(formatElapsed(node.durationMs));
  }
  parts.push(formatCost(node.usage.cost));
  lines.push(parts.join(SEPARATOR));

  for (const child of node.children) {
    formatInstanceTreeLines(child, depth + 1, lines);
  }
  if (node.omitted && node.omitted.count > 0) {
    lines.push(
      [
        `${"  ".repeat(depth + 1)}… ${node.omitted.count} omitted`,
        formatUsageTokens(node.omitted.totals.usage),
        formatCost(node.omitted.totals.usage.cost),
      ].join(SEPARATOR),
    );
  }
}

function formatRunStats(query: string): string | undefined {
  const match = queryRootRunUsage(query);
  if (!match) return undefined;
  const { run, rollup } = match;
  // The root's own duration is the run's wall-clock time; summed instance
  // durations overstate it whenever children run in parallel.
  const header = [
    `${run.instanceName} (${run.id})`,
    plural(rollup.instances, "instance"),
    formatStatusCounts(rollup.statuses),
    formatUsageTokens(rollup.usage),
    formatCost(rollup.usage.cost),
  ];
  if (run.durationMs !== undefined) {
    header.push(formatElapsed(run.durationMs));
  }
  const lines = [header.join(SEPARATOR)];
  formatInstanceTreeLines(run, 0, lines);
  return lines.join("\n");
}

export async function statsCommandHandler(
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify(formatSessionStats() ?? "No subagent runs in this session.");
    return;
  }
  ctx.ui.notify(formatRunStats(target) ?? `No run matches "${target}".`);
}
