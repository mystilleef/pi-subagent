import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSubagentDepth } from "../shared/invocation.js";
import type {
  AccountingStatus,
  UsageInstanceNode,
  UsageStats,
} from "../shared/types.js";
import {
  SUBAGENT_USAGE_ENTRY_TYPE,
  SUBAGENT_USAGE_ENTRY_VERSION,
} from "../shared/usage-entry.js";
import { serializeUsageSnapshot } from "../shared/usage-snapshot.js";
import { isFiniteNonnegative } from "../shared/usage-validation.js";
import {
  attachChildSubtree,
  queryInstanceUsage,
  registerRootInstance,
  snapshotInstanceUsage,
  transitionInstanceStatus,
  updateInstanceSelfUsage,
} from "./usage-ledger.js";

export interface JobUsageIdentity {
  requestId: string;
  agent: string;
  instanceName: string;
  startedAt: number;
}

export interface JobUsageAccount {
  readonly recordSelfUsage: (usage: UsageStats) => void;
  readonly attachChildUsageTree: (usageTree: unknown) => void;
  readonly snapshot: () => UsageInstanceNode | undefined;
  readonly finalize: (
    status: Exclude<AccountingStatus, "running">,
    usage?: UsageStats,
    reportedDurationMs?: number,
  ) => UsageInstanceNode | undefined;
}

// pi turns an extension instance's API stale once its session shuts down
// (session replacement or reload); runs ending afterwards skip persistence
// instead of writing through a stale API.
const shutDownHosts = new WeakSet<ExtensionAPI>();

export function markHostSessionShutdown(pi: ExtensionAPI): void {
  shutDownHosts.add(pi);
}

function safePersistTerminalRootUsage(
  pi: ExtensionAPI,
  isRootProcess: boolean,
  snapshot: UsageInstanceNode | undefined,
): void {
  if (!isRootProcess || shutDownHosts.has(pi)) return;
  if (!snapshot || snapshot.status === "running") return;
  try {
    pi.appendEntry(SUBAGENT_USAGE_ENTRY_TYPE, {
      v: SUBAGENT_USAGE_ENTRY_VERSION,
      run: snapshot,
    });
  } catch {
    /* appendEntry failures never alter job outcome or delivery */
  }
}

// Accounting is best-effort: ledger faults never alter launch, job
// outcome, delivery, or alerts.
function tryLedger<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

export function openJobUsageAccount(
  pi: ExtensionAPI,
  identity: JobUsageIdentity,
): JobUsageAccount {
  const { requestId, startedAt } = identity;
  const isRootProcess = getSubagentDepth() === 0;
  tryLedger(() =>
    registerRootInstance({
      id: requestId,
      agent: identity.agent,
      instanceName: identity.instanceName,
      startedAt,
    }),
  );

  const finalize: JobUsageAccount["finalize"] = (
    status,
    usage,
    reportedDurationMs,
  ) => {
    const endedAt = Date.now();
    const durationMs = isFiniteNonnegative(reportedDurationMs)
      ? reportedDurationMs
      : Math.max(0, endedAt - startedAt);
    if (usage !== undefined) {
      tryLedger(() => updateInstanceSelfUsage(requestId, usage));
    }
    const transitionRes = tryLedger(() =>
      transitionInstanceStatus(requestId, status, { endedAt, durationMs }),
    );
    if (transitionRes?.ok) {
      const usageTree = tryLedger(() =>
        serializeUsageSnapshot(transitionRes.value),
      );
      safePersistTerminalRootUsage(pi, isRootProcess, usageTree);
      return usageTree;
    }
    const existing = tryLedger(() => queryInstanceUsage(requestId));
    return existing && existing.instance.status !== "running"
      ? tryLedger(() => serializeUsageSnapshot(existing.instance))
      : undefined;
  };

  return {
    recordSelfUsage: (usage) => {
      tryLedger(() => updateInstanceSelfUsage(requestId, usage));
    },
    attachChildUsageTree: (usageTree) => {
      tryLedger(() => attachChildSubtree(requestId, usageTree));
    },
    snapshot: () => tryLedger(() => snapshotInstanceUsage(requestId)),
    finalize,
  };
}
