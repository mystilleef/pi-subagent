import type {
  AccountingStatus,
  AdditiveUsage,
  AgentUsageRollup,
  OmittedUsage,
  StatusCounts,
  UsageInstanceNode,
} from "./types.js";
import {
  addStatusCountsInto,
  addUsageInto,
  createAgentRollupMap,
  createEmptyAdditiveUsage,
  createEmptyStatusCounts,
} from "./usage-accounting.js";

// Doubles as the allowed key set of StatusCounts records.
const ACCOUNTING_STATUSES = new Set<string>([
  "running",
  "success",
  "error",
  "cancelled",
]);

const NODE_ALLOWED_KEYS = new Set([
  "id",
  "agent",
  "instanceName",
  "ordinal",
  "startedAt",
  "status",
  "durationMs",
  "usage",
  "children",
  "omitted",
]);

const USAGE_ALLOWED_KEYS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
  "turns",
]);

const OMITTED_ALLOWED_KEYS = new Set(["count", "totals"]);

const ROLLUP_ALLOWED_KEYS = new Set([
  "instances",
  "statuses",
  "usage",
  "durationMs",
  "byAgent",
]);

const AGENT_ROLLUP_ALLOWED_KEYS = new Set([
  "instances",
  "statuses",
  "usage",
  "durationMs",
]);

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ValidateUsageTreeOptions {
  requireTerminal?: boolean | undefined;
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hasOnlyAllowedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Returns the first valid 1-based ordinal; callers list result fields before
 * snapshot roots, so legacy or malformed fields fall through.
 */
export function firstValidOrdinal(
  ...candidates: unknown[]
): number | undefined {
  return candidates.find(isSafePositiveInteger);
}

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

export function validateSelfUsageFields(
  input: unknown,
): ValidationResult<AdditiveUsage> {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "Usage must be a plain object." };
  }
  const inputVal = input["input"];
  const outputVal = input["output"];
  const cacheReadVal = input["cacheRead"];
  const cacheWriteVal = input["cacheWrite"];
  const costVal = input["cost"];
  const turnsVal = input["turns"];

  if (
    !isFiniteNonnegative(inputVal) ||
    !isFiniteNonnegative(outputVal) ||
    !isFiniteNonnegative(cacheReadVal) ||
    !isFiniteNonnegative(cacheWriteVal) ||
    !isFiniteNonnegative(costVal) ||
    !isNonnegativeInteger(turnsVal)
  ) {
    return {
      ok: false,
      error: "Usage fields must be finite nonnegative numbers.",
    };
  }

  return {
    ok: true,
    value: {
      input: inputVal,
      output: outputVal,
      cacheRead: cacheReadVal,
      cacheWrite: cacheWriteVal,
      cost: costVal,
      turns: turnsVal,
    },
  };
}

function validateStrictUsage(input: unknown): ValidationResult<AdditiveUsage> {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "Usage must be a plain object." };
  }
  if (!hasOnlyAllowedKeys(input, USAGE_ALLOWED_KEYS)) {
    return { ok: false, error: "Usage contains disallowed fields." };
  }
  return validateSelfUsageFields(input);
}

function validateStatusCounts(input: unknown): ValidationResult<StatusCounts> {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "Status counts must be a plain object." };
  }
  if (!hasOnlyAllowedKeys(input, ACCOUNTING_STATUSES)) {
    return { ok: false, error: "Status counts contain disallowed fields." };
  }
  const running = input["running"];
  const success = input["success"];
  const error = input["error"];
  const cancelled = input["cancelled"];
  if (
    !isNonnegativeInteger(running) ||
    !isNonnegativeInteger(success) ||
    !isNonnegativeInteger(error) ||
    !isNonnegativeInteger(cancelled)
  ) {
    return {
      ok: false,
      error: "Status counts must be nonnegative integers.",
    };
  }
  return {
    ok: true,
    value: { running, success, error, cancelled },
  };
}

function validateAgentRollup(
  input: unknown,
): ValidationResult<AgentUsageRollup> {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "Agent rollup must be a plain object." };
  }
  if (!hasOnlyAllowedKeys(input, AGENT_ROLLUP_ALLOWED_KEYS)) {
    return { ok: false, error: "Agent rollup contains disallowed fields." };
  }

  const instances = input["instances"];
  if (!isSafePositiveInteger(instances)) {
    return {
      ok: false,
      error: "Agent rollup instances must be a positive integer.",
    };
  }

  const statusesRes = validateStatusCounts(input["statuses"]);
  if (!statusesRes.ok) return statusesRes;

  const statusSum =
    statusesRes.value.running +
    statusesRes.value.success +
    statusesRes.value.error +
    statusesRes.value.cancelled;
  if (statusSum !== instances) {
    return {
      ok: false,
      error: "Agent rollup status counts do not sum to instances.",
    };
  }

  const usageRes = validateStrictUsage(input["usage"]);
  if (!usageRes.ok) return usageRes;

  const durationMs = input["durationMs"];
  if (!isFiniteNonnegative(durationMs)) {
    return {
      ok: false,
      error: "Agent rollup durationMs must be a finite nonnegative number.",
    };
  }

  return {
    ok: true,
    value: {
      instances,
      statuses: statusesRes.value,
      usage: usageRes.value,
      durationMs,
    },
  };
}

function validateOmittedUsage(
  input: unknown,
  requireTerminal: boolean,
): ValidationResult<OmittedUsage> {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "Omitted block must be a plain object." };
  }
  if (!hasOnlyAllowedKeys(input, OMITTED_ALLOWED_KEYS)) {
    return { ok: false, error: "Omitted block contains disallowed fields." };
  }

  const count = input["count"];
  if (!isNonnegativeInteger(count)) {
    return { ok: false, error: "Omitted count must be a nonnegative integer." };
  }

  const totalsRaw = input["totals"];
  if (!isPlainRecord(totalsRaw)) {
    return { ok: false, error: "Omitted totals must be a plain object." };
  }
  if (!hasOnlyAllowedKeys(totalsRaw, ROLLUP_ALLOWED_KEYS)) {
    return { ok: false, error: "Omitted totals contain disallowed fields." };
  }

  const instances = totalsRaw["instances"];
  if (!isNonnegativeInteger(instances) || instances !== count) {
    return {
      ok: false,
      error: "Omitted totals instances must equal omitted count.",
    };
  }

  const statusesRes = validateStatusCounts(totalsRaw["statuses"]);
  if (!statusesRes.ok) return statusesRes;

  if (requireTerminal && statusesRes.value.running > 0) {
    return {
      ok: false,
      error: "Terminal snapshots cannot contain omitted running instances.",
    };
  }

  const statusSum =
    statusesRes.value.running +
    statusesRes.value.success +
    statusesRes.value.error +
    statusesRes.value.cancelled;
  if (statusSum !== count) {
    return {
      ok: false,
      error: "Omitted status counts do not sum to omitted count.",
    };
  }

  const usageRes = validateStrictUsage(totalsRaw["usage"]);
  if (!usageRes.ok) return usageRes;

  const durationMs = totalsRaw["durationMs"];
  if (!isFiniteNonnegative(durationMs)) {
    return {
      ok: false,
      error: "Omitted durationMs must be a finite nonnegative number.",
    };
  }

  const byAgentRaw = totalsRaw["byAgent"];
  if (!isPlainRecord(byAgentRaw)) {
    return { ok: false, error: "Omitted byAgent must be a plain object." };
  }

  const byAgent = createAgentRollupMap();
  let agentInstancesSum = 0;
  const agentStatusesSum = createEmptyStatusCounts();
  const agentUsageSum = createEmptyAdditiveUsage();
  let agentDurationSum = 0;

  for (const [agentName, rawEntry] of Object.entries(byAgentRaw)) {
    if (!isNonEmptyString(agentName)) {
      return {
        ok: false,
        error: "Omitted byAgent keys must be non-empty strings.",
      };
    }
    const agentRes = validateAgentRollup(rawEntry);
    if (!agentRes.ok) return agentRes;
    byAgent[agentName] = agentRes.value;
    agentInstancesSum += agentRes.value.instances;
    addStatusCountsInto(agentStatusesSum, agentRes.value.statuses);
    addUsageInto(agentUsageSum, agentRes.value.usage);
    agentDurationSum += agentRes.value.durationMs;
  }

  if (
    agentInstancesSum !== count ||
    agentStatusesSum.running !== statusesRes.value.running ||
    agentStatusesSum.success !== statusesRes.value.success ||
    agentStatusesSum.error !== statusesRes.value.error ||
    agentStatusesSum.cancelled !== statusesRes.value.cancelled ||
    agentUsageSum.input !== usageRes.value.input ||
    agentUsageSum.output !== usageRes.value.output ||
    agentUsageSum.cacheRead !== usageRes.value.cacheRead ||
    agentUsageSum.cacheWrite !== usageRes.value.cacheWrite ||
    agentUsageSum.turns !== usageRes.value.turns ||
    !approxEqual(agentUsageSum.cost, usageRes.value.cost) ||
    !approxEqual(agentDurationSum, durationMs)
  ) {
    return {
      ok: false,
      error: "Omitted byAgent aggregates do not match omitted totals.",
    };
  }

  return {
    ok: true,
    value: {
      count,
      totals: {
        instances,
        statuses: statusesRes.value,
        usage: usageRes.value,
        durationMs,
        byAgent,
      },
    },
  };
}

function validateNodeRecursive(
  input: unknown,
  requireTerminal: boolean,
  seenIds: Set<string>,
): ValidationResult<UsageInstanceNode> {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "Instance node must be a plain object." };
  }
  if (!hasOnlyAllowedKeys(input, NODE_ALLOWED_KEYS)) {
    return { ok: false, error: "Instance node contains disallowed fields." };
  }

  const id = input["id"];
  if (!isNonEmptyString(id)) {
    return { ok: false, error: "Instance id must be a non-empty string." };
  }
  if (seenIds.has(id)) {
    return { ok: false, error: `Duplicate accounting identity "${id}".` };
  }
  seenIds.add(id);

  const agent = input["agent"];
  if (!isNonEmptyString(agent)) {
    return { ok: false, error: "Instance agent must be a non-empty string." };
  }

  const instanceName = input["instanceName"];
  if (!isNonEmptyString(instanceName)) {
    return {
      ok: false,
      error: "Instance instanceName must be a non-empty string.",
    };
  }

  const ordinal = input["ordinal"];
  if (!isSafePositiveInteger(ordinal)) {
    return {
      ok: false,
      error: "Instance ordinal must be a 1-based positive safe integer.",
    };
  }

  const startedAt = input["startedAt"];
  if (!isFiniteNonnegative(startedAt)) {
    return {
      ok: false,
      error: "Instance startedAt must be a finite nonnegative number.",
    };
  }

  const statusRaw = input["status"];
  if (typeof statusRaw !== "string" || !ACCOUNTING_STATUSES.has(statusRaw)) {
    return { ok: false, error: "Instance status is invalid." };
  }
  const status = statusRaw as AccountingStatus;
  if (requireTerminal && status === "running") {
    return {
      ok: false,
      error: "Terminal snapshots cannot contain running instances.",
    };
  }

  const durationRaw = input["durationMs"];
  let durationMs: number | undefined;
  if (durationRaw !== undefined) {
    if (status === "running") {
      return {
        ok: false,
        error: "Running instances cannot carry a completed durationMs.",
      };
    }
    if (!isFiniteNonnegative(durationRaw)) {
      return {
        ok: false,
        error: "Instance durationMs must be a finite nonnegative number.",
      };
    }
    durationMs = durationRaw;
  }

  const usageRes = validateStrictUsage(input["usage"]);
  if (!usageRes.ok) return usageRes;

  const childrenRaw = input["children"];
  if (!Array.isArray(childrenRaw)) {
    return { ok: false, error: "Instance children must be an array." };
  }

  const children: UsageInstanceNode[] = [];
  for (const childRaw of childrenRaw) {
    const childRes = validateNodeRecursive(childRaw, requireTerminal, seenIds);
    if (!childRes.ok) return childRes;
    children.push(childRes.value);
  }

  let omitted: OmittedUsage | undefined;
  if (input["omitted"] !== undefined) {
    const omittedRes = validateOmittedUsage(input["omitted"], requireTerminal);
    if (!omittedRes.ok) return omittedRes;
    omitted = omittedRes.value;
  }

  const node: UsageInstanceNode = {
    id,
    agent,
    instanceName,
    ordinal,
    startedAt,
    status,
    usage: usageRes.value,
    children,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(omitted !== undefined ? { omitted } : {}),
  };

  return { ok: true, value: node };
}

export function validateUsageTree(
  input: unknown,
  options?: ValidateUsageTreeOptions,
): ValidationResult<UsageInstanceNode> {
  return validateNodeRecursive(
    input,
    options?.requireTerminal ?? false,
    new Set<string>(),
  );
}
