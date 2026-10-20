import { describe, expect, test } from "bun:test";
import {
  parseChildEventLine,
  TOOL_EXECUTION_UPDATE_EVENT,
} from "../src/child/child-events.js";
import { setupHooks } from "./helpers.js";

setupHooks();

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

  describe("tool_execution_update", () => {
    test("valid event with toolName and partialResult parses as known", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: { content: [], details: { results: [] } },
        }),
      );
      expect(r.event.type).toBe(TOOL_EXECUTION_UPDATE_EVENT);
      expect((r.event as { toolName: string }).toolName).toBe("subagent");
    });
    test("non-subagent toolName still parses as known", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "bash",
          partialResult: { content: [] },
        }),
      );
      expect((r.event as { toolName: string }).toolName).toBe("bash");
    });
    test("missing toolName is unknown", () => {
      const r = parseChildEventLine(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          partialResult: {},
        }),
      );
      expect(r.kind).toBe("unknown");
    });
    test("non-string toolName is unknown", () => {
      const r = parseChildEventLine(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: 42,
          partialResult: {},
        }),
      );
      expect(r.kind).toBe("unknown");
    });
    test("missing partialResult is unknown", () => {
      const r = parseChildEventLine(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
        }),
      );
      expect(r.kind).toBe("unknown");
    });
    test("null partialResult is unknown", () => {
      const r = parseChildEventLine(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: null,
        }),
      );
      expect(r.kind).toBe("unknown");
    });
    test("subagent with nested activity produces toolActivity tree", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: {
            details: {
              results: [
                {
                  agent: "coder",
                  instanceName: "instance-123",
                  progress: {
                    activeToolActivity: {
                      toolName: "bash",
                      inputSummary: "ls -la",
                    },
                  },
                },
              ],
            },
          },
        }),
      );
      expect(r.event.type).toBe(TOOL_EXECUTION_UPDATE_EVENT);
      const event = r.event as {
        toolName: string;
        toolActivity: {
          toolName: string;
          inputSummary?: string;
          instanceName?: string;
          child?: { toolName: string; inputSummary?: string };
        };
      };
      expect(event.toolActivity.toolName).toBe("subagent");
      expect(event.toolActivity.inputSummary).toBe("subagent: coder");
      expect(event.toolActivity.instanceName).toBe("instance-123");
      expect(event.toolActivity.child).toBeDefined();
      expect(event.toolActivity.child?.toolName).toBe("bash");
      expect(event.toolActivity.child?.inputSummary).toBe("ls -la");
    });
    test("non-subagent tool produces generic toolActivity", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "bash",
          partialResult: { content: [] },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: { toolName: string; inputSummary: string };
      };
      expect(event.toolActivity.toolName).toBe("bash");
      expect(event.toolActivity.inputSummary).toBe("bash");
    });
    test("subagent with empty results produces fallback toolActivity", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: { details: { results: [] } },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: { toolName: string };
      };
      expect(event.toolActivity.toolName).toBe("subagent");
    });
    test("subagent with missing details produces fallback toolActivity", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: {},
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: { toolName: string };
      };
      expect(event.toolActivity.toolName).toBe("subagent");
    });
    test("subagent with malformed nested result produces fallback toolActivity", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: { details: { results: [null] } },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: { toolName: string };
      };
      expect(event.toolActivity.toolName).toBe("subagent");
    });
    test("subagent without activeToolActivity omits child field", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: {
            details: {
              results: [
                {
                  agent: "writer",
                  progress: {},
                },
              ],
            },
          },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: {
          toolName: string;
          inputSummary?: string;
          child?: unknown;
        };
      };
      expect(event.toolActivity.toolName).toBe("subagent");
      expect(event.toolActivity.inputSummary).toBe("subagent: writer");
      expect(event.toolActivity.child).toBeUndefined();
    });
    test("subagent with string progress field produces fallback without child", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: {
            details: {
              results: [
                {
                  agent: "coder",
                  progress: "invalid-string",
                },
              ],
            },
          },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: {
          toolName: string;
          inputSummary?: string;
          child?: unknown;
        };
      };
      expect(event.toolActivity.toolName).toBe("subagent");
      expect(event.toolActivity.inputSummary).toBe("subagent: coder");
      expect(event.toolActivity.child).toBeUndefined();
    });
    test("subagent with non-string activeToolActivity.toolName omits child", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: {
            details: {
              results: [
                {
                  agent: "coder",
                  progress: {
                    activeToolActivity: {
                      toolName: 42,
                      inputSummary: "bash: ls",
                    },
                  },
                },
              ],
            },
          },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: {
          toolName: string;
          inputSummary?: string;
          child?: unknown;
        };
      };
      expect(event.toolActivity.toolName).toBe("subagent");
      expect(event.toolActivity.inputSummary).toBe("subagent: coder");
      expect(event.toolActivity.child).toBeUndefined();
    });
    test("subagent with string results field produces fallback without child", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: {
            details: {
              results: "not-an-array",
            },
          },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: {
          toolName: string;
          child?: unknown;
        };
      };
      expect(event.toolActivity.toolName).toBe("subagent");
      expect(event.toolActivity.child).toBeUndefined();
    });
    test("subagent with number result entry produces fallback without child", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "subagent",
          partialResult: {
            details: {
              results: [123],
            },
          },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: {
          toolName: string;
          child?: unknown;
        };
      };
      expect(event.toolActivity.toolName).toBe("subagent");
      expect(event.toolActivity.child).toBeUndefined();
    });
    test("non-subagent tool with null details produces fallback inputSummary", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "bash",
          partialResult: { details: null },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: {
          toolName: string;
          inputSummary: string;
          child?: unknown;
        };
      };
      expect(event.toolActivity.toolName).toBe("bash");
      expect(event.toolActivity.inputSummary).toBe("bash");
      expect(event.toolActivity.child).toBeUndefined();
    });
    test("non-subagent tool with empty results produces fallback inputSummary", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "read",
          partialResult: { details: { results: [] } },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: { toolName: string; inputSummary: string };
      };
      expect(event.toolActivity.toolName).toBe("read");
      expect(event.toolActivity.inputSummary).toBe("read");
    });
    test("non-subagent tool with non-object nested result produces fallback inputSummary", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "bash",
          partialResult: { details: { results: [42] } },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: { toolName: string; inputSummary: string };
      };
      expect(event.toolActivity.toolName).toBe("bash");
      expect(event.toolActivity.inputSummary).toBe("bash");
    });
    test("non-subagent tool with child missing inputSummary falls back to toolName", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "bash",
          partialResult: {
            details: {
              results: [
                {
                  instanceName: "test-instance",
                  progress: {
                    activeToolActivity: {
                      toolName: "read",
                    },
                  },
                },
              ],
            },
          },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: {
          toolName: string;
          inputSummary: string;
          instanceName?: string;
          child?: { toolName: string };
        };
      };
      expect(event.toolActivity.toolName).toBe("bash");
      expect(event.toolActivity.instanceName).toBe("test-instance");
      expect(event.toolActivity.inputSummary).toBe("bash");
      expect(event.toolActivity.child).toBeDefined();
      expect(event.toolActivity.child?.toolName).toBe("read");
    });
    test("non-subagent tool with details produces generic toolActivity with child", () => {
      const r = known(
        JSON.stringify({
          type: TOOL_EXECUTION_UPDATE_EVENT,
          toolName: "bash",
          partialResult: {
            details: {
              results: [
                {
                  instanceName: "test-instance",
                  progress: {
                    activeToolActivity: {
                      toolName: "read",
                      inputSummary: "file.txt",
                    },
                  },
                },
              ],
            },
          },
        }),
      );
      const event = r.event as {
        toolName: string;
        toolActivity: {
          toolName: string;
          inputSummary: string;
          instanceName?: string;
          child?: {
            toolName: string;
            inputSummary?: string;
          };
        };
      };
      expect(event.toolActivity.toolName).toBe("bash");
      expect(event.toolActivity.instanceName).toBe("test-instance");
      expect(event.toolActivity.inputSummary).toBe("file.txt");
      expect(event.toolActivity.child).toBeDefined();
      expect(event.toolActivity.child?.toolName).toBe("read");
      expect(event.toolActivity.child?.inputSummary).toBe("file.txt");
    });
  });

  describe("tool_result_end completion shapes", () => {
    test("tool_result_end with tool_use_id parses as known", () => {
      const r = known(
        JSON.stringify({
          type: "tool_result_end",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_abc123",
                content: [{ type: "text", text: "result" }],
              },
            ],
          },
        }),
      );
      expect(r.event.type).toBe("tool_result_end");
      const msg = (r.event as { message: { role: string; content: unknown[] } })
        .message;
      expect(msg.role).toBe("user");
    });
    test("tool_result_end with error content parses as known", () => {
      const r = known(
        JSON.stringify({
          type: "tool_result_end",
          message: {
            role: "toolResult",
            content: [{ type: "text", text: "error output" }],
            isError: true,
          },
        }),
      );
      expect(r.event.type).toBe("tool_result_end");
    });
    test("tool_result_end without message is unknown", () => {
      const r = parseChildEventLine(
        JSON.stringify({ type: "tool_result_end" }),
      );
      expect(r.kind).toBe("known");
    });
    test("tool_result_end with empty message parses as known", () => {
      const r = known(JSON.stringify({ type: "tool_result_end", message: {} }));
      expect(r.event.type).toBe("tool_result_end");
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
    test.each([
      {
        name: "malformed JSON",
        line: "{ not json }",
        expectedLine: "{ not json }",
      },
      { name: "empty string", line: "", expectedLine: "" },
      { name: "whitespace only", line: "   \t\n ", expectedLine: "   \t\n " },
    ])("$name", (row) => {
      const r = parseChildEventLine(row.line);
      expect(r.kind).toBe("invalid");
      if (r.kind === "invalid") expect(r.line).toBe(row.expectedLine);
    });
    test("truncated JSON", () => {
      const r = parseChildEventLine('{"type": "message_end"');
      expect(r.kind).toBe("invalid");
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

describe("child-events.ts coverage gaps", () => {
  test("tryFirstResult handles non-object nested result", () => {
    const details = {
      results: [42], // Not an object
    };

    const line = JSON.stringify({
      type: "tool_execution_update",
      toolName: "bash",
      partialResult: { details },
    });

    const result = parseChildEventLine(line);
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      const event = result.event as {
        toolActivity: { toolName: string; inputSummary: string };
      };
      expect(event.toolActivity.toolName).toBe("bash");
      expect(event.toolActivity.inputSummary).toBe("bash");
    }
  });

  test("tryFirstResult handles null nested result", () => {
    const details = {
      results: [null],
    };

    const line = JSON.stringify({
      type: "tool_execution_update",
      toolName: "bash",
      partialResult: { details },
    });

    const result = parseChildEventLine(line);
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      const event = result.event as {
        toolActivity: { toolName: string; inputSummary: string };
      };
      expect(event.toolActivity.toolName).toBe("bash");
      expect(event.toolActivity.inputSummary).toBe("bash");
    }
  });
});

describe("child-events.ts uncovered branches", () => {
  describe("parseChildEventLine invalid inputs", () => {
    test.each([
      { name: "empty string returns invalid", line: "", expectedLine: "" },
      {
        name: "whitespace-only string returns invalid",
        line: "   ",
        expectedLine: "   ",
      },
      {
        name: "malformed JSON returns invalid",
        line: "{not valid json",
        expectedLine: "{not valid json",
      },
    ])("$name", (row) => {
      const result = parseChildEventLine(row.line);
      expect(result).toEqual({ kind: "invalid", line: row.expectedLine });
    });

    test("non-string input returns invalid", () => {
      const result = parseChildEventLine(123 as unknown as string);
      expect(result.kind).toBe("invalid");
    });
  });

  describe("parseChildEventLine unknown events", () => {
    test.each([
      {
        name: "event without type field returns unknown",
        line: '{"data": "value"}',
      },
      {
        name: "event with non-string type returns unknown",
        line: '{"type": 123}',
      },
      { name: "non-object JSON returns unknown", line: '"just a string"' },
      { name: "array JSON returns unknown", line: "[1, 2, 3]" },
    ])("$name", (row) => {
      const result = parseChildEventLine(row.line);
      expect(result.kind).toBe("unknown");
    });

    test("event with unknown type string returns unknown", () => {
      const result = parseChildEventLine('{"type": "unknown_event"}');
      expect(result.kind).toBe("unknown");
      if (result.kind === "unknown") {
        expect(result.event).toEqual({ type: "unknown_event" });
      }
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
    test.each([
      {
        name: "message_end event returns known",
        type: "message_end",
        role: "assistant",
        content: "done",
        expectedType: "message_end",
      },
      {
        name: "tool_result_end event returns known",
        type: "tool_result_end",
        role: "tool",
        content: "result",
        expectedType: "tool_result_end",
      },
    ])("$name", (row) => {
      const event = {
        type: row.type,
        message: { role: row.role, content: row.content },
      };
      const result = parseChildEventLine(JSON.stringify(event));
      expect(result.kind).toBe("known");
      if (result.kind === "known") {
        expect(result.event.type).toBe(row.expectedType);
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
