import { describe, expect, test } from "bun:test";
import {
  parseChildEventLine,
  TOOL_EXECUTION_UPDATE_EVENT,
} from "../src/child/child-events.js";

describe("child-events.ts uncovered branches", () => {
  describe("parseChildEventLine invalid inputs", () => {
    test("empty string returns invalid", () => {
      const result = parseChildEventLine("");
      expect(result).toEqual({ kind: "invalid", line: "" });
    });

    test("whitespace-only string returns invalid", () => {
      const result = parseChildEventLine("   ");
      expect(result).toEqual({ kind: "invalid", line: "   " });
    });

    test("malformed JSON returns invalid", () => {
      const result = parseChildEventLine("{not valid json");
      expect(result).toEqual({ kind: "invalid", line: "{not valid json" });
    });

    test("non-string input returns invalid", () => {
      const result = parseChildEventLine(123 as unknown as string);
      expect(result.kind).toBe("invalid");
    });

    test("null input returns invalid", () => {
      const result = parseChildEventLine(null as unknown as string);
      expect(result.kind).toBe("invalid");
    });
  });

  describe("parseChildEventLine unknown events", () => {
    test("event without type field returns unknown", () => {
      const result = parseChildEventLine('{"data": "value"}');
      expect(result.kind).toBe("unknown");
    });

    test("event with non-string type returns unknown", () => {
      const result = parseChildEventLine('{"type": 123}');
      expect(result.kind).toBe("unknown");
    });

    test("event with unknown type string returns unknown", () => {
      const result = parseChildEventLine('{"type": "unknown_event"}');
      expect(result.kind).toBe("unknown");
      if (result.kind === "unknown") {
        expect(result.event).toEqual({ type: "unknown_event" });
      }
    });

    test("non-object JSON returns unknown", () => {
      const result = parseChildEventLine('"just a string"');
      expect(result.kind).toBe("unknown");
    });

    test("array JSON returns unknown", () => {
      const result = parseChildEventLine("[1, 2, 3]");
      expect(result.kind).toBe("unknown");
    });
  });

  describe("parseChildEventLine tool_execution_update validation", () => {
    test("missing toolName returns unknown", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        partialResult: { content: "test" },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("unknown");
    });

    test("non-string toolName returns unknown", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: 123,
        partialResult: { content: "test" },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("unknown");
    });

    test("missing partialResult returns unknown", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: "bash",
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("unknown");
    });

    test("null partialResult returns unknown", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: "bash",
        partialResult: null,
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("unknown");
    });

    test("valid tool_execution_update with minimal fields returns known", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: "bash",
        partialResult: {},
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (result.kind === "known") {
        expect(result.event.type).toBe(TOOL_EXECUTION_UPDATE_EVENT);
        if (result.event.type === TOOL_EXECUTION_UPDATE_EVENT) {
          expect(result.event.toolName).toBe("bash");
        }
      }
    });

    test("tool_execution_update with nested details extracts toolActivity", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: "read",
        partialResult: {
          details: {
            results: [
              {
                path: "/tmp/file.txt",
                progress: {
                  activeToolActivity: {
                    toolName: "bash",
                    inputSummary: "echo test",
                  },
                },
              },
            ],
          },
        },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (
        result.kind === "known" &&
        result.event.type === TOOL_EXECUTION_UPDATE_EVENT
      ) {
        expect(result.event.toolActivity).toBeDefined();
        expect(result.event.toolActivity.toolName).toBe("read");
        expect(result.event.toolActivity.child).toBeDefined();
        expect(result.event.toolActivity.child?.toolName).toBe("bash");
      }
    });

    test("subagent tool with agent name uses makeToolPreview", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: "subagent",
        partialResult: {
          details: {
            results: [
              {
                agent: "test-agent",
                command: "run test",
              },
            ],
          },
        },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (
        result.kind === "known" &&
        result.event.type === TOOL_EXECUTION_UPDATE_EVENT
      ) {
        expect(result.event.toolActivity.inputSummary).toContain("subagent");
      }
    });

    test("non-subagent tool with child activity uses child inputSummary", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: "read",
        partialResult: {
          details: {
            results: [
              {
                progress: {
                  activeToolActivity: {
                    toolName: "bash",
                    inputSummary: "child summary",
                  },
                },
              },
            ],
          },
        },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (
        result.kind === "known" &&
        result.event.type === TOOL_EXECUTION_UPDATE_EVENT
      ) {
        expect(result.event.toolActivity.inputSummary).toBe("child summary");
      }
    });

    test("details without results array falls back to toolName", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: "bash",
        partialResult: {
          details: {
            other: "data",
          },
        },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (
        result.kind === "known" &&
        result.event.type === TOOL_EXECUTION_UPDATE_EVENT
      ) {
        expect(result.event.toolActivity.inputSummary).toBe("bash");
      }
    });

    test("empty results array falls back to toolName", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: "bash",
        partialResult: {
          details: {
            results: [],
          },
        },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (
        result.kind === "known" &&
        result.event.type === TOOL_EXECUTION_UPDATE_EVENT
      ) {
        expect(result.event.toolActivity.inputSummary).toBe("bash");
      }
    });

    test("non-object first result falls back to toolName", () => {
      const event = {
        type: TOOL_EXECUTION_UPDATE_EVENT,
        toolName: "bash",
        partialResult: {
          details: {
            results: ["not an object"],
          },
        },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (
        result.kind === "known" &&
        result.event.type === TOOL_EXECUTION_UPDATE_EVENT
      ) {
        expect(result.event.toolActivity.inputSummary).toBe("bash");
      }
    });
  });

  describe("parseChildEventLine known event types", () => {
    test("message_end event returns known", () => {
      const event = {
        type: "message_end",
        message: { role: "assistant", content: "done" },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (result.kind === "known") {
        expect(result.event.type).toBe("message_end");
      }
    });

    test("tool_result_end event returns known", () => {
      const event = {
        type: "tool_result_end",
        message: { role: "tool", content: "result" },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (result.kind === "known") {
        expect(result.event.type).toBe("tool_result_end");
      }
    });

    test("agent_end event returns known", () => {
      const event = {
        type: "agent_end",
        messages: [],
        stopReason: "completed",
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (result.kind === "known") {
        expect(result.event.type).toBe("agent_end");
      }
    });
  });
});
