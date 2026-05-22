import { describe, expect, test } from "bun:test";
import { parseChildEventLine } from "../src/child/child-events.js";

function known(line: string) {
  const r = parseChildEventLine(line);
  if (r.kind !== "known") throw new Error(`Expected known, got ${r.kind}`);
  return r;
}

describe("parseChildEventLine", () => {
  describe("known events", () => {
    test("message_end", () => {
      const r = known(
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: "hi" },
        }),
      );
      expect(r.event.type).toBe("message_end");
      expect((r.event as { message: unknown }).message).toEqual({
        role: "assistant",
        content: "hi",
      });
    });
    test("tool_result_end", () => {
      const r = known(
        JSON.stringify({
          type: "tool_result_end",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "abc" }],
          },
        }),
      );
      expect(r.event.type).toBe("tool_result_end");
      expect((r.event as { message: unknown }).message).toBeDefined();
    });
    test("agent_end with messages and stopReason", () => {
      const r = known(
        JSON.stringify({
          type: "agent_end",
          messages: [{ role: "assistant", content: "done" }],
          stopReason: "end_turn",
        }),
      );
      expect(r.event.type).toBe("agent_end");
      expect((r.event as { messages?: unknown }).messages).toBeDefined();
      expect((r.event as { stopReason?: string }).stopReason).toBe("end_turn");
    });
    test("agent_end without messages", () => {
      const r = known(
        JSON.stringify({ type: "agent_end", stopReason: "max_tokens" }),
      );
      expect(r.event.type).toBe("agent_end");
      expect((r.event as { messages?: unknown }).messages).toBeUndefined();
    });
  });

  describe("unknown events", () => {
    test("unknown type field", () => {
      const r = parseChildEventLine(
        JSON.stringify({ type: "some_future_event", data: 42 }),
      );
      expect(r.kind).toBe("unknown");
    });
    test("missing type field", () => {
      const r = parseChildEventLine(JSON.stringify({ foo: "bar" }));
      expect(r.kind).toBe("unknown");
    });
    test("type is not a string", () => {
      const r = parseChildEventLine(JSON.stringify({ type: 123 }));
      expect(r.kind).toBe("unknown");
    });
  });

  describe("invalid JSON", () => {
    test("malformed JSON", () => {
      const r = parseChildEventLine("{ not json }");
      expect(r.kind).toBe("invalid");
      if (r.kind === "invalid") expect(r.line).toBe("{ not json }");
    });
    test("truncated JSON", () => {
      const r = parseChildEventLine('{"type": "message_end"');
      expect(r.kind).toBe("invalid");
    });
    test("empty string", () => {
      const r = parseChildEventLine("");
      expect(r.kind).toBe("invalid");
      if (r.kind === "invalid") expect(r.line).toBe("");
    });
    test("whitespace only", () => {
      const r = parseChildEventLine("   \t\n ");
      expect(r.kind).toBe("invalid");
      if (r.kind === "invalid") expect(r.line).toBe("   \t\n ");
    });
    test("null input returns invalid", () => {
      // TypeScript forbids null but runtime may pass it; test the guard
      const r = parseChildEventLine(null as unknown as string);
      expect(r.kind).toBe("invalid");
    });
    test("undefined input returns invalid", () => {
      const r = parseChildEventLine(undefined as unknown as string);
      expect(r.kind).toBe("invalid");
    });
  });
});
