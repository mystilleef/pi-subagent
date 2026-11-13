import type {
  AccountingRollup,
  AdditiveUsage,
  AgentUsageRollup,
  OmittedUsage,
  StatusCounts,
  UsageInstanceNode,
} from "./types.js";

export function createEmptyAdditiveUsage(): AdditiveUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

export function createEmptyStatusCounts(): StatusCounts {
  return {
    running: 0,
    success: 0,
    error: 0,
    cancelled: 0,
  };
}

// Agent names are accepted user data, so the record must own every key:
// a null prototype keeps names such as "__proto__" plain data.
export function createAgentRollupMap(): Record<string, AgentUsageRollup> {
  return Object.create(null);
}

function createEmptyAccountingRollup(): AccountingRollup {
  return {
    instances: 0,
    statuses: createEmptyStatusCounts(),
    usage: createEmptyAdditiveUsage(),
    durationMs: 0,
    byAgent: createAgentRollupMap(),
  };
}

export function addUsageInto(
  target: AdditiveUsage,
  source: AdditiveUsage,
): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.turns += source.turns;
}

export function addStatusCountsInto(
  target: StatusCounts,
  source: StatusCounts,
): void {
  target.running += source.running;
  target.success += source.success;
  target.error += source.error;
  target.cancelled += source.cancelled;
}

export function cloneAccountingRollup(
  rollup: AccountingRollup,
): AccountingRollup {
  const byAgent = createAgentRollupMap();
  for (const [agent, entry] of Object.entries(rollup.byAgent)) {
    byAgent[agent] = {
      instances: entry.instances,
      statuses: { ...entry.statuses },
      usage: { ...entry.usage },
      durationMs: entry.durationMs,
    };
  }
  return {
    instances: rollup.instances,
    statuses: { ...rollup.statuses },
    usage: { ...rollup.usage },
    durationMs: rollup.durationMs,
    byAgent,
  };
}

function cloneOmittedUsage(omitted: OmittedUsage): OmittedUsage {
  return {
    count: omitted.count,
    totals: cloneAccountingRollup(omitted.totals),
  };
}

export function cloneUsageInstanceNode(
  node: UsageInstanceNode,
): UsageInstanceNode {
  return {
    id: node.id,
    agent: node.agent,
    instanceName: node.instanceName,
    ordinal: node.ordinal,
    startedAt: node.startedAt,
    status: node.status,
    usage: { ...node.usage },
    children: node.children.map(cloneUsageInstanceNode),
    ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
    ...(node.omitted !== undefined
      ? { omitted: cloneOmittedUsage(node.omitted) }
      : {}),
  };
}

function getOrCreateAgentRollup(
  byAgent: Record<string, AgentUsageRollup>,
  agent: string,
): AgentUsageRollup {
  let entry = byAgent[agent];
  if (!entry) {
    entry = {
      instances: 0,
      statuses: createEmptyStatusCounts(),
      usage: createEmptyAdditiveUsage(),
      durationMs: 0,
    };
    byAgent[agent] = entry;
  }
  return entry;
}

function mergeRollupInto(
  target: AccountingRollup,
  source: AccountingRollup,
): void {
  target.instances += source.instances;
  addStatusCountsInto(target.statuses, source.statuses);
  addUsageInto(target.usage, source.usage);
  target.durationMs += source.durationMs;
  for (const [agent, entry] of Object.entries(source.byAgent)) {
    const dest = getOrCreateAgentRollup(target.byAgent, agent);
    dest.instances += entry.instances;
    addStatusCountsInto(dest.statuses, entry.statuses);
    addUsageInto(dest.usage, entry.usage);
    dest.durationMs += entry.durationMs;
  }
}

function accumulateSubtreeInto(
  node: UsageInstanceNode,
  target: AccountingRollup,
): void {
  const reportedDuration =
    node.status !== "running" && node.durationMs !== undefined
      ? node.durationMs
      : 0;

  target.instances += 1;
  target.statuses[node.status] += 1;
  addUsageInto(target.usage, node.usage);
  target.durationMs += reportedDuration;

  const agentEntry = getOrCreateAgentRollup(target.byAgent, node.agent);
  agentEntry.instances += 1;
  agentEntry.statuses[node.status] += 1;
  addUsageInto(agentEntry.usage, node.usage);
  agentEntry.durationMs += reportedDuration;

  for (const child of node.children) {
    accumulateSubtreeInto(child, target);
  }

  if (node.omitted) {
    mergeRollupInto(target, node.omitted.totals);
  }
}

export function computeSubtreeRollup(
  node: UsageInstanceNode,
): AccountingRollup {
  const rollup = createEmptyAccountingRollup();
  accumulateSubtreeInto(node, rollup);
  return rollup;
}

export function combineRollups(
  rollups: readonly AccountingRollup[],
): AccountingRollup {
  const combined = createEmptyAccountingRollup();
  for (const rollup of rollups) {
    mergeRollupInto(combined, rollup);
  }
  return combined;
}

export function collectTreeIds(
  node: UsageInstanceNode,
  ids: Set<string> = new Set<string>(),
): Set<string> {
  ids.add(node.id);
  for (const child of node.children) {
    collectTreeIds(child, ids);
  }
  return ids;
}
