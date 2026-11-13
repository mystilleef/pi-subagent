import type {
  AccountingRollup,
  OmittedUsage,
  StatusCounts,
  UsageInstanceNode,
} from "./types.js";
import {
  cloneAccountingRollup,
  combineRollups,
  computeSubtreeRollup,
  createAgentRollupMap,
} from "./usage-accounting.js";
import { isFiniteNonnegative } from "./usage-validation.js";

export const MAX_USAGE_SNAPSHOT_NODES = 50;

export interface SerializeUsageSnapshotOptions {
  maxNodes?: number | undefined;
}

export interface ReconcileTerminalOptions {
  endedAt?: number | undefined;
}

interface SnapshotCandidate {
  node: UsageInstanceNode;
  parent: SnapshotCandidate | undefined;
  depth: number;
}

// Descendants of `root` in visit order; stable sorting keeps that order as
// the final tie-breaker.
function collectSnapshotCandidates(
  root: UsageInstanceNode,
): SnapshotCandidate[] {
  const candidates: SnapshotCandidate[] = [];
  const visit = (
    node: UsageInstanceNode,
    parent: SnapshotCandidate | undefined,
    depth: number,
  ): void => {
    const entry: SnapshotCandidate = { node, parent, depth };
    if (parent) candidates.push(entry);
    for (const child of node.children) {
      visit(child, entry, depth + 1);
    }
  };
  visit(root, undefined, 0);
  return candidates;
}

function buildTrimmedSnapshotNode(
  node: UsageInstanceNode,
  retainedIds: ReadonlySet<string>,
): UsageInstanceNode {
  const retainedChildren: UsageInstanceNode[] = [];
  const omittedRollups: AccountingRollup[] = [];

  if (node.omitted) {
    omittedRollups.push(cloneAccountingRollup(node.omitted.totals));
  }

  for (const child of node.children) {
    if (retainedIds.has(child.id)) {
      retainedChildren.push(buildTrimmedSnapshotNode(child, retainedIds));
    } else {
      omittedRollups.push(computeSubtreeRollup(child));
    }
  }

  let omitted: OmittedUsage | undefined;
  if (omittedRollups.length > 0) {
    const totals = combineRollups(omittedRollups);
    omitted = {
      count: totals.instances,
      totals,
    };
  }

  return {
    id: node.id,
    agent: node.agent,
    instanceName: node.instanceName,
    ordinal: node.ordinal,
    startedAt: node.startedAt,
    status: node.status,
    usage: { ...node.usage },
    children: retainedChildren,
    ...(node.durationMs !== undefined ? { durationMs: node.durationMs } : {}),
    ...(omitted !== undefined ? { omitted } : {}),
  };
}

function terminalSnapshotEndedAt(node: UsageInstanceNode): number | undefined {
  return isFiniteNonnegative(node.startedAt) &&
    isFiniteNonnegative(node.durationMs)
    ? node.startedAt + node.durationMs
    : undefined;
}

export function serializeUsageSnapshot(
  root: UsageInstanceNode,
  options?: SerializeUsageSnapshotOptions,
): UsageInstanceNode {
  const requestedNodes = options?.maxNodes ?? MAX_USAGE_SNAPSHOT_NODES;
  if (!Number.isInteger(requestedNodes) || requestedNodes < 1) {
    throw new RangeError("maxNodes must be a positive integer.");
  }
  const maxNodes = Math.min(requestedNodes, MAX_USAGE_SNAPSHOT_NODES);

  // Callers pass ledger-built or boundary-validated trees; trimming
  // builds fresh nodes, so the input stays untouched.
  const candidates = collectSnapshotCandidates(root).sort(
    (a, b) =>
      Number(b.node.status === "running") -
        Number(a.node.status === "running") ||
      b.node.startedAt - a.node.startedAt ||
      a.depth - b.depth ||
      a.node.ordinal - b.node.ordinal,
  );
  const retainedIds = new Set<string>([root.id]);
  let remaining = maxNodes - 1;

  for (const candidate of candidates) {
    if (remaining === 0) break;

    // The retained root ends every walk.
    const unretainedAncestors: string[] = [];
    for (
      let current: SnapshotCandidate | undefined = candidate;
      current && !retainedIds.has(current.node.id);
      current = current.parent
    ) {
      unretainedAncestors.push(current.node.id);
    }

    if (unretainedAncestors.length <= remaining) {
      for (const id of unretainedAncestors) {
        retainedIds.add(id);
      }
      remaining -= unretainedAncestors.length;
    }
  }

  const snapshot = buildTrimmedSnapshotNode(root, retainedIds);
  if (root.status === "running") {
    return snapshot;
  }

  return reconcileTerminalDescendants(snapshot, {
    endedAt: terminalSnapshotEndedAt(root),
  });
}

function reconcileStatusCountsToTerminal(statuses: StatusCounts): StatusCounts {
  return {
    running: 0,
    success: statuses.success,
    error: statuses.error,
    cancelled: statuses.cancelled + statuses.running,
  };
}

function reconcileOmittedUsageToTerminal(omitted: OmittedUsage): OmittedUsage {
  const byAgent = createAgentRollupMap();
  for (const [agent, entry] of Object.entries(omitted.totals.byAgent)) {
    byAgent[agent] = {
      instances: entry.instances,
      statuses: reconcileStatusCountsToTerminal(entry.statuses),
      usage: { ...entry.usage },
      durationMs: entry.durationMs,
    };
  }
  return {
    count: omitted.count,
    totals: {
      instances: omitted.totals.instances,
      statuses: reconcileStatusCountsToTerminal(omitted.totals.statuses),
      usage: { ...omitted.totals.usage },
      durationMs: omitted.totals.durationMs,
      byAgent,
    },
  };
}

function reconcileNodeRecursive(
  node: UsageInstanceNode,
  isRoot: boolean,
  endedAt: number | undefined,
): UsageInstanceNode {
  const children = node.children.map((child) =>
    reconcileNodeRecursive(child, false, endedAt),
  );
  const omitted = node.omitted
    ? reconcileOmittedUsageToTerminal(node.omitted)
    : undefined;

  let status = node.status;
  let durationMs = node.durationMs;
  if (!isRoot && status === "running") {
    status = "cancelled";
    durationMs =
      isFiniteNonnegative(endedAt) && isFiniteNonnegative(node.startedAt)
        ? Math.max(0, endedAt - node.startedAt)
        : undefined;
  }

  return {
    id: node.id,
    agent: node.agent,
    instanceName: node.instanceName,
    ordinal: node.ordinal,
    startedAt: node.startedAt,
    status,
    usage: { ...node.usage },
    children,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(omitted !== undefined ? { omitted } : {}),
  };
}

export function reconcileTerminalDescendants(
  node: UsageInstanceNode,
  options?: ReconcileTerminalOptions,
): UsageInstanceNode {
  const endedAt = isFiniteNonnegative(options?.endedAt)
    ? options?.endedAt
    : undefined;
  return reconcileNodeRecursive(node, true, endedAt);
}
