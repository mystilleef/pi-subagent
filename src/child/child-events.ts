type ChildKnownEvent =
  | { type: "message_end"; message: unknown }
  | { type: "tool_result_end"; message: unknown }
  | { type: "agent_end"; messages?: unknown; stopReason?: string };

export type ChildEventParseResult =
  | { kind: "known"; event: ChildKnownEvent }
  | { kind: "unknown"; event: unknown }
  | { kind: "invalid"; line: string };

const KNOWN_TYPES = new Set(["message_end", "tool_result_end", "agent_end"]);

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
    return { kind: "known", event: event as ChildKnownEvent };
  }
  return { kind: "unknown", event };
}
