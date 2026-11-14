import { makeToolPreview } from "../output/normalize.js";
import type { ToolActivity } from "../shared/types.js";
import { firstValidOrdinal } from "../shared/usage-validation.js";

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Raw snapshot only; receivers validate it at ingest.
export function extractUsageTreeFromDetails(details: unknown): unknown {
  return isPlainObjectRecord(details) ? details["usageTree"] : undefined;
}

export function extractUsageTreeFromToolResultMessage(
  message: unknown,
): unknown {
  if (!isPlainObjectRecord(message)) return undefined;
  if (message["role"] !== "toolResult") return undefined;
  if (message["toolName"] !== "subagent") return undefined;
  return extractUsageTreeFromDetails(message["details"]);
}

function tryFirstResult(details: unknown): Record<string, unknown> | null {
  try {
    if (typeof details !== "object" || details === null) return null;
    const results = (details as Record<string, unknown>)["results"];
    if (!Array.isArray(results) || results.length === 0) return null;
    const nested = results[0];
    if (typeof nested !== "object" || nested === null) return null;
    return nested as Record<string, unknown>;
  } catch {
    /* malformed details structure returns null to use fallback preview */
    return null;
  }
}

function extractNestedOrdinal(
  nestedRecord: Record<string, unknown> | null,
  details: unknown,
): number | undefined {
  const tree = extractUsageTreeFromDetails(details);
  return firstValidOrdinal(
    nestedRecord?.["ordinal"],
    isPlainObjectRecord(tree) ? tree["ordinal"] : undefined,
  );
}

function parseToolActivity(
  toolName: string,
  partialResult: { content?: unknown; details?: unknown },
): ToolActivity {
  const nestedRecord = tryFirstResult(partialResult.details);
  const activity: ToolActivity = { toolName, inputSummary: toolName };
  const ordinal = extractNestedOrdinal(nestedRecord, partialResult.details);
  if (ordinal !== undefined) activity.ordinal = ordinal;
  if (!nestedRecord) return activity;
  const isSubagent = toolName === "subagent";
  const agent =
    typeof nestedRecord["agent"] === "string" && nestedRecord["agent"];
  if (isSubagent && agent) {
    activity.inputSummary = makeToolPreview(toolName, nestedRecord);
  }
  if (
    typeof nestedRecord["instanceName"] === "string" &&
    nestedRecord["instanceName"]
  ) {
    activity.instanceName = nestedRecord["instanceName"] as string;
  }
  const progress = nestedRecord["progress"];
  if (typeof progress === "object" && progress !== null) {
    const activeToolActivity = (progress as Record<string, unknown>)[
      "activeToolActivity"
    ];
    if (
      typeof activeToolActivity === "object" &&
      activeToolActivity !== null &&
      typeof (activeToolActivity as Record<string, unknown>)["toolName"] ===
        "string"
    ) {
      const childActivity = activeToolActivity as ToolActivity;
      activity.child = childActivity;
      // Subagent delegates inputSummary to its own agent name, not child
      if (
        !isSubagent &&
        typeof childActivity.inputSummary === "string" &&
        childActivity.inputSummary
      ) {
        activity.inputSummary = childActivity.inputSummary;
      }
    }
  }
  return activity;
}

export type ChildKnownEvent =
  | { type: "message_end"; message: unknown }
  | { type: "tool_result_end"; message: unknown }
  | { type: "agent_end"; messages?: unknown; stopReason?: string }
  | {
      type: "tool_execution_update";
      toolName: string;
      partialResult: { content?: unknown; details?: unknown };
      toolActivity: ToolActivity;
      usageTree?: unknown;
    };

export type ChildEventParseResult =
  | { kind: "known"; event: ChildKnownEvent }
  | { kind: "unknown"; event: unknown }
  | { kind: "invalid"; line: string };

export const TOOL_EXECUTION_UPDATE_EVENT = "tool_execution_update" as const;

const KNOWN_TYPES = new Set([
  "message_end",
  "tool_result_end",
  "agent_end",
  TOOL_EXECUTION_UPDATE_EVENT,
]);

export function parseChildEventLine(line: string): ChildEventParseResult {
  if (typeof line !== "string" || !line.trim())
    return { kind: "invalid", line };
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    /* malformed JSON lines are marked invalid for diagnostic reporting */
    return { kind: "invalid", line };
  }
  if (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    typeof (event as Record<string, unknown>)["type"] === "string" &&
    KNOWN_TYPES.has((event as Record<string, unknown>)["type"] as string)
  ) {
    const record = event as Record<string, unknown>;
    if (record["type"] === TOOL_EXECUTION_UPDATE_EVENT) {
      if (
        typeof record["toolName"] !== "string" ||
        typeof record["partialResult"] !== "object" ||
        record["partialResult"] === null
      ) {
        return { kind: "unknown", event };
      }
      const partialResult = record["partialResult"] as {
        content?: unknown;
        details?: unknown;
      };
      record["toolActivity"] = parseToolActivity(
        record["toolName"] as string,
        partialResult,
      );
      const usageTree =
        record["toolName"] === "subagent"
          ? extractUsageTreeFromDetails(partialResult.details)
          : undefined;
      if (usageTree !== undefined) {
        record["usageTree"] = usageTree;
      } else {
        delete record["usageTree"];
      }
    }
    return { kind: "known", event: event as ChildKnownEvent };
  }
  return { kind: "unknown", event };
}
