import type {
  AccountingStatus,
  AdditiveUsage,
  InstanceUsageQueryResult,
  RunUsageQueryResult,
  SessionUsageQueryResult,
  UsageInstanceNode,
  UsageStats,
} from "../shared/types.js";
import {
  cloneUsageInstanceNode,
  collectTreeIds,
  combineRollups,
  computeSubtreeRollup,
  createEmptyAdditiveUsage,
} from "../shared/usage-accounting.js";
import {
  reconcileTerminalDescendants,
  serializeUsageSnapshot,
} from "../shared/usage-snapshot.js";
import {
  isFiniteNonnegative,
  isNonEmptyString,
  validateSelfUsageFields,
  validateUsageTree,
} from "../shared/usage-validation.js";

export type LedgerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface RegisterRootInstanceInput {
  id: string;
  agent: string;
  instanceName: string;
  startedAt?: number | undefined;
}

export interface TransitionInstanceOptions {
  endedAt?: number | undefined;
  durationMs?: number | undefined;
  usage?: AdditiveUsage | UsageStats | undefined;
}

export interface RestoreSessionRunsResult {
  restoredCount: number;
  skippedCount: number;
}

interface InternalRootRecord {
  node: UsageInstanceNode;
  seq: number;
}

// An extension instance serves one pi session (pi reloads extensions per
// session runtime), so the ledger holds that session's runs only: live
// roots launched by this instance plus runs restored from its entries.
const rootsById = new Map<string, InternalRootRecord>();
const restoredById = new Map<string, InternalRootRecord>();
const rootOrdinalMax = new Map<string, number>();
let nextSeq = 1;

function findNodeInTree(
  node: UsageInstanceNode,
  id: string,
): UsageInstanceNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNodeInTree(child, id);
    if (found) return found;
  }
  return undefined;
}

function findNodeInRoots(id: string): UsageInstanceNode | undefined {
  for (const record of rootsById.values()) {
    const found = findNodeInTree(record.node, id);
    if (found) return found;
  }
  return undefined;
}

function hasAnyHeldId(ids: ReadonlySet<string>): boolean {
  for (const record of getAllRecords()) {
    if (treeContainsAnyId(record.node, ids)) return true;
  }
  return false;
}

function treeContainsAnyId(
  node: UsageInstanceNode,
  ids: ReadonlySet<string>,
  excludedIds?: ReadonlySet<string>,
): boolean {
  if (ids.has(node.id) && !excludedIds?.has(node.id)) return true;
  for (const child of node.children) {
    if (treeContainsAnyId(child, ids, excludedIds)) return true;
  }
  return false;
}

function bumpOrdinalMax(
  agentMap: Map<string, number>,
  agent: string,
  ordinal: number,
): void {
  if (ordinal > (agentMap.get(agent) ?? 0)) {
    agentMap.set(agent, ordinal);
  }
}

function nextOrdinal(maxOrdinal: number, agent: string): LedgerResult<number> {
  if (maxOrdinal >= Number.MAX_SAFE_INTEGER) {
    return {
      ok: false,
      error: `Ordinal sequence for agent "${agent}" is exhausted.`,
    };
  }
  return { ok: true, value: maxOrdinal + 1 };
}

function allocateRootOrdinal(agent: string): LedgerResult<number> {
  let maxOrdinal = rootOrdinalMax.get(agent) ?? 0;
  for (const record of getAllRecords()) {
    if (record.node.agent === agent) {
      maxOrdinal = Math.max(maxOrdinal, record.node.ordinal);
    }
  }
  const nextRes = nextOrdinal(maxOrdinal, agent);
  if (!nextRes.ok) return nextRes;
  bumpOrdinalMax(rootOrdinalMax, agent, nextRes.value);
  return nextRes;
}

export function resetUsageLedger(): void {
  rootsById.clear();
  restoredById.clear();
  rootOrdinalMax.clear();
  nextSeq = 1;
}

export function registerRootInstance(
  input: RegisterRootInstanceInput,
): LedgerResult<UsageInstanceNode> {
  if (
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.agent) ||
    !isNonEmptyString(input.instanceName)
  ) {
    return {
      ok: false,
      error: "Root instance id, agent, and instanceName must be non-empty.",
    };
  }
  const startedAt = input.startedAt ?? Date.now();
  if (!isFiniteNonnegative(startedAt)) {
    return {
      ok: false,
      error: "Root instance startedAt must be a finite nonnegative number.",
    };
  }
  if (hasAnyHeldId(new Set([input.id]))) {
    return {
      ok: false,
      error: `Accounting identity "${input.id}" is already registered.`,
    };
  }

  const ordinalRes = allocateRootOrdinal(input.agent);
  if (!ordinalRes.ok) return ordinalRes;
  const ordinal = ordinalRes.value;
  const node: UsageInstanceNode = {
    id: input.id,
    agent: input.agent,
    instanceName: input.instanceName,
    ordinal,
    startedAt,
    status: "running",
    usage: createEmptyAdditiveUsage(),
    children: [],
  };

  rootsById.set(node.id, { node, seq: nextSeq++ });
  return { ok: true, value: cloneUsageInstanceNode(node) };
}

export function updateInstanceSelfUsage(
  id: string,
  usage: AdditiveUsage | UsageStats,
): LedgerResult<UsageInstanceNode> {
  if (!isNonEmptyString(id)) {
    return { ok: false, error: "Instance id must be a non-empty string." };
  }
  const node = findNodeInRoots(id);
  if (!node) {
    return { ok: false, error: `Instance "${id}" was not found.` };
  }
  const usageRes = validateSelfUsageFields(usage);
  if (!usageRes.ok) return usageRes;

  node.usage = usageRes.value;
  return { ok: true, value: cloneUsageInstanceNode(node) };
}

export function transitionInstanceStatus(
  id: string,
  status: Exclude<AccountingStatus, "running">,
  options?: TransitionInstanceOptions,
): LedgerResult<UsageInstanceNode> {
  if (!isNonEmptyString(id)) {
    return { ok: false, error: "Instance id must be a non-empty string." };
  }
  if (status !== "success" && status !== "error" && status !== "cancelled") {
    return { ok: false, error: `Invalid terminal status "${String(status)}".` };
  }
  const node = findNodeInRoots(id);
  if (!node) {
    return { ok: false, error: `Instance "${id}" was not found.` };
  }
  if (node.status !== "running") {
    return { ok: false, error: `Instance "${id}" is already terminal.` };
  }

  let durationMs: number;
  let reconcileEndedAt: number | undefined;
  if (options?.durationMs !== undefined) {
    if (!isFiniteNonnegative(options.durationMs)) {
      return {
        ok: false,
        error: "Terminal durationMs must be a finite nonnegative number.",
      };
    }
    durationMs = options.durationMs;
    if (options.endedAt !== undefined) {
      if (!isFiniteNonnegative(options.endedAt)) {
        return {
          ok: false,
          error: "Terminal endedAt must be a finite nonnegative number.",
        };
      }
      reconcileEndedAt = options.endedAt;
    }
  } else {
    const endedAt = options?.endedAt ?? Date.now();
    if (!isFiniteNonnegative(endedAt)) {
      return {
        ok: false,
        error: "Terminal endedAt must be a finite nonnegative number.",
      };
    }
    durationMs = Math.max(0, endedAt - node.startedAt);
    reconcileEndedAt = endedAt;
  }

  let nextUsage: AdditiveUsage | undefined;
  if (options?.usage !== undefined) {
    const usageRes = validateSelfUsageFields(options.usage);
    if (!usageRes.ok) return usageRes;
    nextUsage = usageRes.value;
  }

  node.status = status;
  node.durationMs = durationMs;
  if (nextUsage !== undefined) {
    node.usage = nextUsage;
  }
  const reconciled = reconcileTerminalDescendants(node, {
    endedAt: reconcileEndedAt,
  });
  node.children = reconciled.children;
  if (reconciled.omitted !== undefined) {
    node.omitted = reconciled.omitted;
  }

  return { ok: true, value: cloneUsageInstanceNode(node) };
}

function retainAssignedOrdinals(
  incoming: UsageInstanceNode,
  replacedSubtree: UsageInstanceNode,
): void {
  const existing = findNodeInTree(replacedSubtree, incoming.id);
  if (existing) {
    incoming.ordinal = existing.ordinal;
  }
  for (const child of incoming.children) {
    retainAssignedOrdinals(child, replacedSubtree);
  }
}

export function attachChildSubtree(
  parentId: string,
  childSubtree: unknown,
): LedgerResult<UsageInstanceNode> {
  if (!isNonEmptyString(parentId)) {
    return { ok: false, error: "Parent id must be a non-empty string." };
  }
  const parent = findNodeInRoots(parentId);
  if (!parent) {
    return { ok: false, error: `Parent instance "${parentId}" was not found.` };
  }

  const validation = validateUsageTree(childSubtree);
  if (!validation.ok) return validation;

  const incoming = validation.value;
  const incomingIds = collectTreeIds(incoming);

  const existingIndex = parent.children.findIndex((c) => c.id === incoming.id);
  const existingChild =
    existingIndex >= 0 ? parent.children[existingIndex] : undefined;
  const excludedIds = existingChild ? collectTreeIds(existingChild) : undefined;

  for (const record of getAllRecords()) {
    if (treeContainsAnyId(record.node, incomingIds, excludedIds)) {
      return {
        ok: false,
        error:
          "Child subtree contains an accounting identity that collides with an existing instance.",
      };
    }
  }

  if (existingChild) {
    retainAssignedOrdinals(incoming, existingChild);
    parent.children[existingIndex] = incoming;
  } else {
    parent.children.push(incoming);
  }

  return { ok: true, value: cloneUsageInstanceNode(incoming) };
}

export function restoreSessionRuns(
  runs: readonly unknown[],
): RestoreSessionRunsResult {
  restoredById.clear();
  const heldIds = new Set<string>();
  for (const record of rootsById.values()) {
    collectTreeIds(record.node, heldIds);
  }

  let restoredCount = 0;
  let skippedCount = 0;
  for (const rawRun of runs) {
    const validation = validateUsageTree(rawRun, { requireTerminal: true });
    if (!validation.ok) {
      skippedCount += 1;
      continue;
    }
    const node = validation.value;
    const nodeIds = collectTreeIds(node);
    if (!nodeIds.isDisjointFrom(heldIds)) {
      skippedCount += 1;
      continue;
    }
    for (const id of nodeIds) heldIds.add(id);
    restoredById.set(node.id, { node, seq: nextSeq++ });
    bumpOrdinalMax(rootOrdinalMax, node.agent, node.ordinal);
    restoredCount += 1;
  }
  return { restoredCount, skippedCount };
}

function getAllRecords(): InternalRootRecord[] {
  return [...restoredById.values(), ...rootsById.values()].sort(
    (a, b) => b.node.startedAt - a.node.startedAt || b.seq - a.seq,
  );
}

export function querySessionUsage(): SessionUsageQueryResult {
  const records = getAllRecords();
  return {
    rollup: combineRollups(
      records.map((record) => computeSubtreeRollup(record.node)),
    ),
    runs: records.map((record) => cloneUsageInstanceNode(record.node)),
  };
}

export function queryRootRunUsage(
  query: string,
): RunUsageQueryResult | undefined {
  if (!isNonEmptyString(query)) return undefined;
  const records = getAllRecords();
  const match =
    records.find((record) => record.node.id === query) ??
    records.find((record) => record.node.instanceName === query);
  if (!match) return undefined;
  return {
    run: cloneUsageInstanceNode(match.node),
    rollup: computeSubtreeRollup(match.node),
  };
}

function findHeldNode(requestId: string): UsageInstanceNode | undefined {
  if (!isNonEmptyString(requestId)) return undefined;
  for (const record of getAllRecords()) {
    const found = findNodeInTree(record.node, requestId);
    if (found) return found;
  }
  return undefined;
}

export function queryInstanceUsage(
  requestId: string,
): InstanceUsageQueryResult | undefined {
  const found = findHeldNode(requestId);
  if (!found) return undefined;
  return {
    instance: cloneUsageInstanceNode(found),
    rollup: computeSubtreeRollup(found),
  };
}

export function snapshotInstanceUsage(
  requestId: string,
  maxNodes?: number,
): UsageInstanceNode | undefined {
  const found = findHeldNode(requestId);
  return found ? serializeUsageSnapshot(found, { maxNodes }) : undefined;
}
