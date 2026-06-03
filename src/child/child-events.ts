import { makeToolPreview } from "../output/normalize.js";
import type { ToolActivity } from "../shared/types.js";

// Extracts results[0] from details; null-safe for malformed input.
function tryFirstResult(details: unknown): Record<string, unknown> | null {
  try {
    if (typeof details !== "object" || details === null) return null;
    const results = (details as Record<string, unknown>).results;
    if (!Array.isArray(results) || results.length === 0) return null;
    const nested = results[0];
    if (typeof nested !== "object" || nested === null) return null;
    return nested as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Malformed details (null result) falls back to { toolName }.
function parseToolActivity(
  toolName: string,
  partialResult: { content?: unknown; details?: unknown },
): ToolActivity {
  const nestedRecord = tryFirstResult(partialResult.details);
  if (!nestedRecord) return { toolName, inputSummary: toolName };
  const isSubagent = toolName === "subagent";
  const activity: ToolActivity = { toolName };
  const agent = typeof nestedRecord.agent === "string" && nestedRecord.agent;
  activity.inputSummary =
    isSubagent && agent ? makeToolPreview(toolName, nestedRecord) : toolName;
  if (
    typeof nestedRecord.instanceName === "string" &&
    nestedRecord.instanceName
  ) {
    activity.instanceName = nestedRecord.instanceName;
  }
  const progress = nestedRecord.progress;
  if (typeof progress === "object" && progress !== null) {
    const activeToolActivity = (progress as Record<string, unknown>)
      .activeToolActivity;
    if (
      typeof activeToolActivity === "object" &&
      activeToolActivity !== null &&
      typeof (activeToolActivity as Record<string, unknown>).toolName ===
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
    return { kind: "invalid", line };
  }
  if (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    typeof (event as Record<string, unknown>).type === "string" &&
    KNOWN_TYPES.has((event as Record<string, unknown>).type as string)
  ) {
    const record = event as Record<string, unknown>;
    if (record.type === TOOL_EXECUTION_UPDATE_EVENT) {
      if (
        typeof record.toolName !== "string" ||
        typeof record.partialResult !== "object" ||
        record.partialResult === null
      ) {
        return { kind: "unknown", event };
      }
      record.toolActivity = parseToolActivity(
        record.toolName as string,
        record.partialResult as { content?: unknown; details?: unknown },
      );
    }
    return { kind: "known", event: event as ChildKnownEvent };
  }
  return { kind: "unknown", event };
}
