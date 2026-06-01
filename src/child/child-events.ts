export type ChildKnownEvent =
  | { type: "message_end"; message: unknown }
  | { type: "tool_result_end"; message: unknown }
  | { type: "agent_end"; messages?: unknown; stopReason?: string }
  | { type: "subagent_nested_activity"; activityText: string };

export type ChildEventParseResult =
  | { kind: "known"; event: ChildKnownEvent }
  | { kind: "unknown"; event: unknown }
  | { kind: "invalid"; line: string };

export const NESTED_ACTIVITY_EVENT = "subagent_nested_activity" as const;

const KNOWN_TYPES = new Set([
  "message_end",
  "tool_result_end",
  "agent_end",
  NESTED_ACTIVITY_EVENT,
]);

export function makeNestedActivityLine(activityText: string): string {
  return JSON.stringify({ type: NESTED_ACTIVITY_EVENT, activityText });
}

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
      record.type === NESTED_ACTIVITY_EVENT &&
      typeof record.activityText !== "string"
    ) {
      return { kind: "unknown", event };
    }
    return { kind: "known", event: event as ChildKnownEvent };
  }
  return { kind: "unknown", event };
}
