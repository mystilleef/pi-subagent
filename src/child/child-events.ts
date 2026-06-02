export type ChildKnownEvent =
  | { type: "message_end"; message: unknown }
  | { type: "tool_result_end"; message: unknown }
  | { type: "agent_end"; messages?: unknown; stopReason?: string }
  | {
      type: "tool_execution_update";
      toolName: string;
      partialResult: { content?: unknown; details?: unknown };
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
    if (
      record.type === TOOL_EXECUTION_UPDATE_EVENT &&
      typeof record.toolName !== "string"
    ) {
      return { kind: "unknown", event };
    }
    if (
      record.type === TOOL_EXECUTION_UPDATE_EVENT &&
      (typeof record.partialResult !== "object" ||
        record.partialResult === null)
    ) {
      return { kind: "unknown", event };
    }
    return { kind: "known", event: event as ChildKnownEvent };
  }
  return { kind: "unknown", event };
}
