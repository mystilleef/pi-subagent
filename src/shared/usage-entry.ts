import { hasOnlyAllowedKeys, isPlainRecord } from "./usage-validation.js";

export const SUBAGENT_USAGE_ENTRY_TYPE = "subagent-usage";
export const SUBAGENT_USAGE_ENTRY_VERSION = 1;

const USAGE_ENTRY_DATA_KEYS = new Set(["v", "run"]);

// Raw run of a subagent-usage v1 entry; restoration validates it.
export function extractPersistedUsageRun(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (
    record["type"] !== "custom" ||
    record["customType"] !== SUBAGENT_USAGE_ENTRY_TYPE
  ) {
    return undefined;
  }
  const data = record["data"];
  if (
    !isPlainRecord(data) ||
    !hasOnlyAllowedKeys(data, USAGE_ENTRY_DATA_KEYS) ||
    data["v"] !== SUBAGENT_USAGE_ENTRY_VERSION
  ) {
    return undefined;
  }
  return data["run"];
}
