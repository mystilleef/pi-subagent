import { describe, expect, test } from "bun:test";
import {
  parseChildEventLine,
  TOOL_EXECUTION_UPDATE_EVENT,
} from "../src/child/child-events.js";

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
