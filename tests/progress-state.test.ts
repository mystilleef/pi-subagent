import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { summarizeFeedbackUiFinalOutput } from "../src/output/summary.js";
import {
  cancelProgressState,
  clearProgressState,
  failProgressState,
  makeTaskPreview,
  patchProgressState,
  renderSubagentProgress,
  resetProgressStore,
} from "../src/progress/progress.js";
import {
  createProgressState,
  extractProgressFromDetails,
  finalizeProgressState,
  getAllProgressStates,
  getProgressState,
  isToolCallPart,
} from "../src/progress/progress-state.js";
import type { SubagentDetails } from "../src/shared/types.js";
import { CANONICAL_SUMMARY_FIXTURES } from "./fixtures.js";
// Explicit agent/agentSource overrides preserve the former local
// makeSingleResult defaults at each migrated call site.
import { makeSingleResult } from "./helpers.js";

test("progress final output matches feedback summary for canonical fixtures", () => {
  const requestId = `contract-${Date.now()}`;
  createProgressState(requestId, "test-agent", "test task");
  finalizeProgressState(requestId, "SUCCESS");
  const state = getProgressState(requestId);
  expect(state?.finalOutput).toBe("completed task");
  expect(summarizeFeedbackUiFinalOutput("SUCCESS", undefined)).toBe(
    "completed task",
  );
});

describe("progress-state.ts coverage gaps", () => {
  describe("extractProgressFromExistingProgress edge cases", () => {
    test("progress with activeToolActivity sets activeToolActivity in state", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
              activeToolActivity: {
                toolName: "bash",
                inputSummary: "echo hello",
              },
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.activeToolActivity).toBeDefined();
      expect(result.activeToolActivity?.toolName).toBe("bash");
      expect(result.activeToolActivity?.inputSummary).toBe("echo hello");
    });

    test("progress with toolResultCompleted sets flag in state", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
              toolResultCompleted: true,
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.toolResultCompleted).toBe(true);
    });

    test("progress with lastToolPreview but no toolCalls sets lastToolPreview via fallback", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
              lastToolPreview: "bash: ls -la",
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.lastToolPreview).toBe("bash: ls -la");
      expect(result.progressLastToolPreview).toBe("bash: ls -la");
    });

    test("progress with lastToolPreview and toolCalls sets lastToolPreview from tool call not fallback", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [{ id: "tc-1", preview: "read: file.txt" }],
              lastToolPreview: "bash: stale preview",
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.lastToolPreview).toBe("read: file.txt");
      expect(result.progressLastToolPreview).toBe("bash: stale preview");
      expect(result.newToolCallIds).toEqual(["tc-1"]);
    });

    test("progress with whitespace-only lastToolPreview does not set preview", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
              lastToolPreview: "   ",
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.lastToolPreview).toBeUndefined();
      expect(result.progressLastToolPreview).toBeUndefined();
    });

    test("progress with non-string lastToolPreview does not set preview", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
              lastToolPreview: 123 as unknown as string,
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.lastToolPreview).toBeUndefined();
      expect(result.progressLastToolPreview).toBeUndefined();
    });

    test("progress with toolCalls containing non-derived tool calls skips them", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [
                { id: "valid", preview: "bash: echo" },
                { id: 123, preview: "invalid id" } as unknown as {
                  id: string;
                  preview: string;
                },
                { preview: "missing id" } as unknown as {
                  id: string;
                  preview: string;
                },
                { id: "missing preview" } as unknown as {
                  id: string;
                  preview: string;
                },
              ],
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toEqual(["valid"]);
    });
  });

  describe("extractProgressFromMessages edge cases", () => {
    test("messages with toolCall parts extract tool calls", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "tool-1",
                    name: "read",
                    arguments: { path: "/tmp/file" },
                  },
                ],
              } as unknown as Message,
            ],
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toContain("tool-1");
    });

    test("messages without assistant role are skipped", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "toolCall",
                    id: "tool-1",
                    name: "read",
                    arguments: { path: "/tmp/file" },
                  },
                ],
              } as unknown as Message,
            ],
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toEqual([]);
    });

    test("assistant messages with non-array content are skipped", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [
              {
                role: "assistant",
                content: "not an array",
              } as unknown as Message,
            ],
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toEqual([]);
    });

    test("assistant messages with non-toolCall parts are skipped", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "just text",
                  },
                  {
                    type: "toolCall",
                    id: "tool-1",
                    name: "bash",
                    arguments: { command: "ls" },
                  },
                ],
              } as unknown as Message,
            ],
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toEqual(["tool-1"]);
    });

    test("assistant messages with invalid toolCall parts are skipped", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: 123,
                    name: "read",
                  } as unknown as {
                    type: "toolCall";
                    id: string;
                    name: string;
                  },
                  {
                    type: "toolCall",
                    name: "bash",
                  } as unknown as {
                    type: "toolCall";
                    id: string;
                    name: string;
                  },
                  {
                    type: "notToolCall",
                    id: "tool-1",
                    name: "read",
                  } as unknown as {
                    type: "toolCall";
                    id: string;
                    name: string;
                  },
                ],
              } as unknown as Message,
            ],
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toEqual([]);
    });
  });

  describe("extractProgressFromDetails result handling", () => {
    test("details with non-array results returns empty state", () => {
      const details = {
        results: "not an array",
      } as unknown as SubagentDetails;
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toEqual([]);
      expect(result.activityText).toBeUndefined();
    });

    test("result with non-array messages and no progress returns empty state", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: "not an array" as unknown as Message[],
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toEqual([]);
    });

    test("multiple results with progress and messages process both", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [{ id: "tc-1", preview: "read: file1" }],
              activityText: "Reading file1",
            },
          }),
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "tc-2",
                    name: "bash",
                    arguments: { command: "ls" },
                  },
                ],
              } as unknown as Message,
            ],
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toContain("tc-1");
      expect(result.newToolCallIds).toContain("tc-2");
      expect(result.activityText).toBe("Reading file1");
    });
  });
});

describe("progress-state.ts extractProgressFromExistingProgress branches", () => {
  describe("activityText normalization", () => {
    test("progress with whitespace-only activityText does not set activityText", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
              activityText: "   ",
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.activityText).toBeUndefined();
    });

    test("progress with non-string activityText does not set activityText", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
              activityText: 123 as unknown as string,
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.activityText).toBeUndefined();
    });

    test("progress with long activityText truncates it", () => {
      const longText = "a".repeat(200);
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
              activityText: longText,
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.activityText).toBeDefined();
      expect(result.activityText?.length).toBeLessThanOrEqual(120);
    });
  });

  describe("toolCalls validation", () => {
    test("toolCalls with duplicate IDs are deduplicated", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [
                { id: "tc-1", preview: "bash: echo" },
                { id: "tc-1", preview: "bash: echo again" },
              ],
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toEqual(["tc-1"]);
    });

    test("toolCalls with already-seen IDs are filtered out", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [{ id: "tc-1", preview: "bash: echo" }],
            },
          }),
        ],
      };
      const seen = new Set<string>(["tc-1"]);
      const result = extractProgressFromDetails(details, seen);
      expect(result.newToolCallIds).toEqual([]);
    });
  });

  describe("activeToolActivity nested structure", () => {
    test("progress with valid activeToolActivity sets it in state", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
              activeToolActivity: {
                toolName: "bash",
                inputSummary: "echo test",
              },
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.activeToolActivity).toBeDefined();
      expect(result.activeToolActivity?.toolName).toBe("bash");
    });

    test("progress with undefined activeToolActivity does not set it", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.activeToolActivity).toBeUndefined();
    });
  });

  describe("toolResultCompleted flag", () => {
    test("progress without toolResultCompleted does not set flag", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "test",
            agentSource: "user",
            messages: [],
            progress: {
              toolCalls: [],
            },
          }),
        ],
      };
      const seen = new Set<string>();
      const result = extractProgressFromDetails(details, seen);
      expect(result.toolResultCompleted).toBeUndefined();
    });
  });
});

describe("progress-state.ts isToolCallPart validation", () => {
  describe("isToolCallPart edge cases", () => {
    test("null returns false", () => {
      expect(isToolCallPart(null)).toBe(false);
    });

    test("undefined returns false", () => {
      expect(isToolCallPart(undefined)).toBe(false);
    });

    test("string returns false", () => {
      expect(isToolCallPart("not an object")).toBe(false);
    });

    test("number returns false", () => {
      expect(isToolCallPart(123)).toBe(false);
    });

    test("array returns false", () => {
      expect(isToolCallPart([1, 2, 3])).toBe(false);
    });

    test("empty object returns false", () => {
      expect(isToolCallPart({})).toBe(false);
    });

    test("object with type but missing id returns false", () => {
      expect(isToolCallPart({ type: "toolCall", name: "bash" })).toBe(false);
    });

    test("object with type but missing name returns false", () => {
      expect(isToolCallPart({ type: "toolCall", id: "tool-1" })).toBe(false);
    });

    test("object with type but non-string id returns false", () => {
      expect(isToolCallPart({ type: "toolCall", id: 123, name: "bash" })).toBe(
        false,
      );
    });

    test("object with type but non-string name returns false", () => {
      expect(
        isToolCallPart({ type: "toolCall", id: "tool-1", name: 123 }),
      ).toBe(false);
    });

    test("object with wrong type returns false", () => {
      expect(isToolCallPart({ type: "text", id: "tool-1", name: "bash" })).toBe(
        false,
      );
    });

    test("valid toolCall part returns true", () => {
      const part = {
        type: "toolCall",
        id: "tool-1",
        name: "bash",
        arguments: { command: "ls" },
      };
      expect(isToolCallPart(part)).toBe(true);
    });

    test("valid toolCall part without arguments returns true", () => {
      const part = {
        type: "toolCall",
        id: "tool-1",
        name: "bash",
      };
      expect(isToolCallPart(part)).toBe(true);
    });

    test("valid toolCall part with empty arguments returns true", () => {
      const part = {
        type: "toolCall",
        id: "tool-1",
        name: "bash",
        arguments: {},
      };
      expect(isToolCallPart(part)).toBe(true);
    });
  });
});

test("createProgressState initializes defaults", () => {
  const before = Date.now();
  createProgressState("req-1", "my-agent", "do the thing");
  const state = getProgressState("req-1");
  expect(state).toBeDefined();
  expect(state?.requestId).toBe("req-1");
  expect(state?.agent).toBe("my-agent");
  expect(state?.taskPreview).toBe("do the thing");
  expect(state?.status).toBe("running");
  expect(state?.startTime).toBeGreaterThanOrEqual(before);
  expect(state?.toolCount).toBe(0);
  expect(state?.lastToolPreview).toBeUndefined();
  expect(state?.modelDisplay).toBeUndefined();
  expect(state?.finalOutput).toBeUndefined();
  expect(state?.errorText).toBeUndefined();
});

test("patchProgressState sets modelDisplay", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { modelDisplay: "claude-3-5-sonnet" });
  expect(getProgressState("req-1")?.modelDisplay).toBe("claude-3-5-sonnet");
});

test("terminal helpers preserve modelDisplay and strip transient tool fields", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    modelDisplay: "claude-3-5-sonnet",
    lastToolPreview: "bash: ls",
  });
  finalizeProgressState("req-1", "all done");
  const successState = getProgressState("req-1");
  expect(successState?.modelDisplay).toBe("claude-3-5-sonnet");
  expect(successState?.lastToolPreview).toBeUndefined();

  createProgressState("req-2", "agent-b", "task b");
  patchProgressState("req-2", {
    modelDisplay: "gpt-4o",
    lastToolPreview: "read: /tmp/file",
  });
  failProgressState("req-2", "child failed");
  const errorState = getProgressState("req-2");
  expect(errorState?.modelDisplay).toBe("gpt-4o");
  expect(errorState?.lastToolPreview).toBeUndefined();

  createProgressState("req-3", "agent-c", "task c");
  patchProgressState("req-3", {
    modelDisplay: "gemini-1.5-pro",
    lastToolPreview: "write: safe.txt",
  });
  cancelProgressState("req-3", "user aborted");
  const cancelledState = getProgressState("req-3");
  expect(cancelledState?.modelDisplay).toBe("gemini-1.5-pro");
  expect(cancelledState?.lastToolPreview).toBeUndefined();
});

test("empty or undefined modelDisplay leaves footer data absent", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { modelDisplay: "" });
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
  patchProgressState("req-1", { modelDisplay: "claude-3-5-sonnet" });
  expect(getProgressState("req-1")?.modelDisplay).toBe("claude-3-5-sonnet");
  patchProgressState("req-1", { modelDisplay: undefined });
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
  patchProgressState("req-1", { modelDisplay: "gemini-1.5-pro" });
  expect(getProgressState("req-1")?.modelDisplay).toBe("gemini-1.5-pro");
  patchProgressState("req-1", { modelDisplay: "" });
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
});

describe("unconfirmed thinking progress propagation", () => {
  test("finalized progress state retains requested-level modelDisplay", () => {
    createProgressState("req-1", "agent-a", "task a");
    patchProgressState("req-1", { modelDisplay: "unknown ･ unknown ･ high" });
    finalizeProgressState("req-1", "all done");
    expect(getProgressState("req-1")?.modelDisplay).toBe(
      "unknown ･ unknown ･ high",
    );
  });
});

test("getProgressState returns undefined for unknown request id", () => {
  expect(getProgressState("nonexistent")).toBeUndefined();
});

test("patchProgressState merges fields without replacing unpatched fields", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { toolCount: 3, lastToolPreview: "bash: ls" });
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(3);
  expect(state?.lastToolPreview).toBe("bash: ls");
  expect(state?.agent).toBe("agent-a");
  expect(state?.status).toBe("running");
});

test("finalizeProgressState sets success status and semantic final output", () => {
  createProgressState("req-1", "agent-a", "task a");
  finalizeProgressState("req-1", "all done");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("success");
  expect(state?.finalOutput).toBe("all done");
  expect(state?.errorText).toBeUndefined();
});

for (const fixture of CANONICAL_SUMMARY_FIXTURES) {
  test(`progress final output matches canonical summary for ${fixture.name}`, () => {
    createProgressState("req-fixture", "agent-fixture", "task fixture");
    finalizeProgressState("req-fixture", fixture.finalOutput, fixture.outcome);
    expect(getProgressState("req-fixture")?.finalOutput).toBe(
      fixture.expectedProgress,
    );
  });
}

test("progress final output substitutes status-only success after canonical derivation", () => {
  createProgressState("req-1", "agent-a", "task a");
  finalizeProgressState("req-1", "ignored output", "done");
  expect(getProgressState("req-1")?.finalOutput).toBe("completed task");
  createProgressState("req-2", "agent-b", "task b");
  finalizeProgressState("req-2", "ignored output", "Success");
  expect(getProgressState("req-2")?.finalOutput).toBe("completed task");
});

test("terminal failure normalizes status prefixes and status-only text", () => {
  createProgressState("req-1", "agent-a", "task a");
  failProgressState("req-1", "FAILURE: child failed");
  expect(getProgressState("req-1")?.errorText).toBe("child failed");
  createProgressState("req-2", "agent-b", "task b");
  failProgressState("req-2", "FAILURE: FAILURE");
  expect(getProgressState("req-2")?.errorText).toBe("task failed");
  createProgressState("req-3", "agent-c", "task c");
  failProgressState("req-3", "Error: ERROR");
  expect(getProgressState("req-3")?.errorText).toBe("task failed");
  createProgressState("req-4", "agent-d", "task d");
  failProgressState("req-4", "FAILURE: Error: permission denied");
  expect(getProgressState("req-4")?.errorText).toBe("permission denied");
});

test("terminal helpers clear transient tool fields and compact semantic text", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "bash: noisy command" });
  const longOutcome = `Outcome: implemented ${"x".repeat(600)}`;
  finalizeProgressState("req-1", longOutcome);
  const successState = getProgressState("req-1");
  expect(successState?.lastToolPreview).toBeUndefined();
  expect(successState?.finalOutput).toStartWith("outcome: implemented ");
  expect(successState?.finalOutput).toEndWith("…");
  createProgressState("req-2", "agent-b", "task b");
  patchProgressState("req-2", { lastToolPreview: "read: /tmp/file" });
  const longCause = `migration failed ${"e".repeat(600)}`;
  failProgressState("req-2", longCause);
  const errorState = getProgressState("req-2");
  expect(errorState?.lastToolPreview).toBeUndefined();
  expect(errorState?.errorText).toStartWith("migration failed ");
  expect(errorState?.errorText).toEndWith("…");
});

test("progress error omits long unstructured blobs", () => {
  createProgressState("req-1", "agent-a", "task a");
  const blob = Array.from(
    { length: 60 },
    (_, index) => `at Object.fn (/tmp/noisy-${index}.js:1:1)`,
  ).join("\n");
  failProgressState("req-1", blob);
  const state = getProgressState("req-1");
  expect(state?.errorText).toBe("Large unstructured error output omitted.");
  expect(state?.errorText).not.toContain("noisy-1");
});

test("progress error chooses status error check then semantic line", () => {
  createProgressState("req-1", "agent-a", "task a");
  failProgressState(
    "req-1",
    "debug: noisy\nCheck: bun test failed\nmeaningful fallback line",
  );
  expect(getProgressState("req-1")?.errorText).toBe("bun test failed");
  createProgressState("req-2", "agent-b", "task b");
  failProgressState("req-2", "debug: noisy\nmeaningful fallback line");
  expect(getProgressState("req-2")?.errorText).toBe("meaningful fallback line");
});

test("failProgressState sets error status and error text", () => {
  createProgressState("req-1", "agent-a", "task a");
  failProgressState("req-1", "something exploded");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("error");
  expect(state?.errorText).toBe("something exploded");
  expect(state?.finalOutput).toBeUndefined();
});

test("cancelProgressState sets cancelled status with unprefixed reason", () => {
  createProgressState("req-1", "agent-a", "task a");
  cancelProgressState("req-1", "Status: user aborted");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBe("user aborted");
});

test("cancelled progress ignores late tool previews", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "bash: running" });
  cancelProgressState("req-1", "user cancelled");
  patchProgressState("req-1", { lastToolPreview: "read: stale" });
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.lastToolPreview).toBeUndefined();
  expect(state?.errorText).toBe("user cancelled");
});

test("cancelProgressState with no reason leaves errorText undefined", () => {
  createProgressState("req-1", "agent-a", "task a");
  cancelProgressState("req-1");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBeUndefined();
});

test("terminal helpers capture deterministic duration", () => {
  setDateNow(1000);
  createProgressState("req-1", "agent-a", "task a");
  setDateNow(3450);
  finalizeProgressState("req-1", "all done");
  expect(getProgressState("req-1")?.durationMs).toBe(2450);
  setDateNow(2000);
  createProgressState("req-2", "agent-b", "task b");
  setDateNow(7600);
  failProgressState("req-2", "something exploded");
  expect(getProgressState("req-2")?.durationMs).toBe(5600);
});

test("terminal helper no-ops for missing state", () => {
  expect(() => finalizeProgressState("req-1", "all done")).not.toThrow();
  expect(getProgressState("req-1")).toBeUndefined();
});

test("terminal helpers preserve existing duration", () => {
  setDateNow(1000);
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { durationMs: 123 });
  setDateNow(9000);
  cancelProgressState("req-1", "user aborted");
  const state = getProgressState("req-1");
  expect(state?.durationMs).toBe(123);
  expect(state?.status).toBe("cancelled");
});

test("terminal durations stay isolated by request", () => {
  setDateNow(1000);
  createProgressState("iso-success", "agent-a", "task a");
  setDateNow(2000);
  createProgressState("iso-error", "agent-b", "task b");
  setDateNow(3000);
  createProgressState("iso-running", "agent-c", "task c");
  setDateNow(5500);
  finalizeProgressState("iso-success", "all done");
  expect(getProgressState("iso-success")?.durationMs).toBe(4500);
  expect(getProgressState("iso-error")?.durationMs).toBeUndefined();
  expect(getProgressState("iso-running")?.durationMs).toBeUndefined();
  setDateNow(9000);
  failProgressState("iso-error", "child failed");
  expect(getProgressState("iso-success")?.durationMs).toBe(4500);
  expect(getProgressState("iso-error")?.durationMs).toBe(7000);
  setDateNow(12_500);
  const theme = makeTheme();
  const runningResult = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "iso-running" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(runningResult)).toContain("9.5s");
  expect(getProgressState("iso-running")?.durationMs).toBeUndefined();
});

test("clearProgressState removes state", () => {
  createProgressState("req-1", "agent-a", "task a");
  clearProgressState("req-1");
  expect(getProgressState("req-1")).toBeUndefined();
});

test("clearProgressState is a no-op for unknown id", () => {
  expect(() => clearProgressState("nonexistent")).not.toThrow();
});

test.each([
  {
    name: "makeTaskPreview returns full text when within bound",
    text: "short task",
    expected: "short task",
  },
  {
    name: "makeTaskPreview labels empty task as agent default",
    text: "",
    expected: "(agent default)",
  },
  {
    name: "makeTaskPreview collapses whitespace",
    text: "line one\nline two",
    expected: "line one line two",
  },
])("$name", (row) => {
  expect(makeTaskPreview(row.text)).toBe(row.expected);
});

test("makeTaskPreview keeps long semantic task text", () => {
  const long = "a".repeat(100);
  const preview = makeTaskPreview(long);
  expect(preview).toBe(long);
  expect(preview).not.toContain("...");
});

test("multiple independent request ids are isolated", () => {
  createProgressState("req-1", "agent-a", "task a");
  createProgressState("req-2", "agent-b", "task b");
  finalizeProgressState("req-1", "output a");
  const s1 = getProgressState("req-1");
  const s2 = getProgressState("req-2");
  expect(s1?.status).toBe("success");
  expect(s2?.status).toBe("running");
  expect(s2?.agent).toBe("agent-b");
});

test("extractProgressFromDetails returns empty result for details with no messages", () => {
  const details = makeDetails([]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails returns derived progress without messages", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  delete firstResult.messages;
  firstResult.progress = {
    toolCalls: [
      { id: "safe-1", preview: "bash: ls" },
      { id: "safe-2", preview: "read: /tmp/foo" },
    ],
    lastToolPreview: "read: /tmp/foo",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-1", "safe-2"]);
  expect(result.lastToolPreview).toBe("read: /tmp/foo");
  expect([...seen]).toEqual(["safe-1", "safe-2"]);
});

test("extractProgressFromDetails prefers derived progress over legacy messages", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "raw-1",
          name: "bash",
          arguments: { command: "secret-token" },
        },
      ],
    },
  ]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "safe-1", preview: "bash" }],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-1"]);
  expect(result.lastToolPreview).toBe("bash");
  expect(seen.has("raw-1")).toBe(false);
});

test("extractProgressFromDetails ignores malformed derived progress ids", () => {
  const details = makeDetails([]) as unknown as SubagentDetails;
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "safe-1", preview: "bash" },
      { id: 7, preview: "bad" },
      { id: "bad", preview: null },
    ] as unknown as { id: string; preview: string }[],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-1"]);
  expect(result.lastToolPreview).toBe("bash");
});

test("extractProgressFromDetails normalizes derived progress previews", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "safe-1", preview: "bash: printf 'a'\n\t  echo b" },
      { id: "safe-2", preview: `read: /tmp/foo\n${"x".repeat(130)}` },
    ],
  };
  const seen = new Set<string>(["safe-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-2"]);
  expect(result.lastToolPreview).toBe(`read: /tmp/foo ${"x".repeat(104)}…`);
  expect([...seen]).toEqual(["safe-1", "safe-2"]);
});

test("extractProgressFromDetails returns new tool call ids from assistant messages", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "tc-2",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toContain("tc-1");
  expect(result.newToolCallIds).toContain("tc-2");
  expect(result.newToolCallIds.length).toBe(2);
});

test("extractProgressFromDetails skips already-seen tool call ids", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "tc-2",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    },
  ]);
  const seen = new Set(["tc-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-2"]);
});

test("extractProgressFromDetails returns undefined lastToolPreview but populated activityText when all derived progress tool calls are already seen", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-1", preview: "bash: ls" },
      { id: "tc-2", preview: "read: /tmp/file" },
    ],
    activityText: "read: /tmp/file",
    lastToolPreview: "read: /tmp/file",
  };
  const seen = new Set(["tc-1", "tc-2"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("read: /tmp/file");
});

test("extractProgressFromDetails mutates seen ids and reports count delta", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
        { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
        { type: "toolCall", id: "tc-2", name: "read", arguments: {} },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-1", "tc-2"]);
  expect([...seen].sort()).toEqual(["tc-1", "tc-2"]);
});

test("extractProgressFromDetails handles malformed and nested message data safely", () => {
  const details = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      { messages: null },
      { messages: [{ role: "assistant", content: null }] },
      {
        messages: [
          {
            role: "assistant",
            content: [
              null,
              { type: "toolCall", id: 42, name: "bad" },
              {
                type: "toolCall",
                id: "tc-nested",
                name: "outer",
                arguments: { nested: { path: "/tmp/x" } },
              },
            ],
          },
        ],
      },
    ],
  } as unknown as SubagentDetails;
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-nested"]);
  expect(result.lastToolPreview).toBe("outer");
});

test("extractProgressFromDetails returns last tool preview", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "tc-2",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("read: /tmp/foo");
});

test("extractProgressFromDetails omits unknown secret arguments", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-secret",
          name: "unknown_tool",
          arguments: {
            token: "secret-token",
            password: "secret-password",
            nested: { value: "secret-nested" },
          },
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("unknown_tool");
  expect(result.lastToolPreview).not.toContain(":");
  expect(result.lastToolPreview).not.toContain("secret");
});

test("extractProgressFromDetails ignores non-assistant messages", () => {
  const details = makeDetails([
    { role: "user", content: [{ type: "text", text: "do something" }] },
    {
      role: "toolResult",
      content: [
        {
          type: "toolResultContent",
          toolCallId: "tc-x",
          content: [{ type: "text", text: "done" }],
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
});

test("extractProgressFromDetails handles empty output when no results", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
});

test("extractProgressFromDetails returns activityText from nested activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading file.ts",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("Reading file.ts");
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails prefers child tool preview over nested activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "Reading file.ts",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.activityText).toBe("Reading file.ts");
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("extractProgressFromDetails does not create tool-call IDs for nested activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Scanning codebase",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(seen.size).toBe(0);
});

test("extractProgressFromDetails normalizes and truncates nested activity text", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const longActivity = `${"x".repeat(150)}`;
  firstResult.progress = {
    toolCalls: [],
    activityText: `Reading ${longActivity}`,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeDefined();
  const chars = Array.from(result.activityText ?? "");
  expect(chars.length).toBeLessThanOrEqual(120);
  expect(result.activityText).toEndWith("…");
});

test("child-owned tool updates regain preview precedence after nested activity", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "Nested: scanning files" });
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Nested: scanning files",
  );
  patchProgressState("req-1", {
    lastToolPreview: "bash: ls -la",
    toolCount: 1,
  });
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("bash: ls -la");
  expect(state?.toolCount).toBe(1);
});

test("terminal states clear nested activity preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "Nested: reading file.ts" });
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Nested: reading file.ts",
  );
  finalizeProgressState("req-1", "all done");
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  createProgressState("req-2", "agent-b", "task b");
  patchProgressState("req-2", { lastToolPreview: "Nested: scanning" });
  failProgressState("req-2", "child failed");
  expect(getProgressState("req-2")?.lastToolPreview).toBeUndefined();
  createProgressState("req-3", "agent-c", "task c");
  patchProgressState("req-3", { lastToolPreview: "Nested: working" });
  cancelProgressState("req-3", "user aborted");
  expect(getProgressState("req-3")?.lastToolPreview).toBeUndefined();
});

test.each([
  {
    name: "extractProgressFromDetails ignores whitespace-only activityText",
    activityText: "   ",
  },
  {
    name: "extractProgressFromDetails ignores empty activityText",
    activityText: "",
  },
])("$name", (row) => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: row.activityText,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails ignores non-string activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: 42 as unknown as string,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test.each([
  {
    name: "extractProgressFromDetails normalizes nested activity whitespace",
    activityText: "Reading file.ts\n\twith tabs",
    expected: "Reading file.ts with tabs",
  },
  {
    name: "extractProgressFromDetails redacts sensitive nested activity keywords",
    activityText: "Reading secret-token.yaml",
    expected: "Reading secret-token.yaml",
  },
])("$name", (row) => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: row.activityText,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe(row.expected);
});

test("extractProgressFromDetails updates seen set without tool-call drift from activity", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-child",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    },
  ]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: ls" }],
    activityText: "Nested: reading file.ts",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-child"]);
  expect([...seen]).toEqual(["tc-child"]);
  expect(result.activityText).toBe("Nested: reading file.ts");
});

test("extractProgressFromDetails ignores already-seen derived previews with activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: stale" }],
    activityText: "Nested: reading fresh.ts",
    lastToolPreview: "bash: stale",
  };
  const seen = new Set<string>(["tc-child"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("Nested: reading fresh.ts");
  expect([...seen]).toEqual(["tc-child"]);
});

test("extractProgressFromDetails keeps last fresh preview ahead of repeated IDs", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-child", preview: "bash: fresh" },
      { id: "tc-child", preview: "bash: stale" },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-child"]);
  expect(result.lastToolPreview).toBe("bash: fresh");
  expect([...seen]).toEqual(["tc-child"]);
});

test("child default preview fallback: extractProgressFromDetails returns no new tool-call IDs when all child IDs are already seen", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = "bash: ls";
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: childDefaultPreview }],
    activityText: childDefaultPreview,
    lastToolPreview: childDefaultPreview,
  };
  const seen = new Set<string>(["child-tool-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.activityText).toBe(childDefaultPreview);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("default fallback detection returns false when child has no activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: "bash: ls" }],
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>(["child-tool-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual([]);
});

test("extractProgressFromDetails skips non-string progress lastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "scanning",
    lastToolPreview: 123 as unknown as string,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("scanning");
  expect(result.lastToolPreview).toBe("bash: ls");
});

test("extractProgressFromDetails skips empty progress lastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "scanning",
    lastToolPreview: "   ",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("scanning");
});

test("extractProgressFromDetails captures activityText and progressLastToolPreview independently", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "genuine nested activity",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("genuine nested activity");
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("getAllProgressStates returns empty array for empty store", () => {
  resetProgressStore();
  expect(getAllProgressStates()).toEqual([]);
});

test("terminal success clears activeToolActivity and lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: { toolName: "bash", inputSummary: "bash: ls" },
    },
    lastToolPreview: "subagent: build - bash: ls",
    toolCount: 2,
  });
  finalizeProgressState("req-1", "done");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("success");
  expect(state?.activeToolActivity).toBeUndefined();
  expect(state?.lastToolPreview).toBeUndefined();
});

test("terminal error clears activeToolActivity and lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
    },
    lastToolPreview: "subagent: build",
    toolCount: 1,
  });
  failProgressState("req-1", "child failed");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("error");
  expect(state?.activeToolActivity).toBeUndefined();
  expect(state?.lastToolPreview).toBeUndefined();
});

test("terminal cancellation clears activeToolActivity and lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
    },
    lastToolPreview: "subagent: build",
    toolCount: 1,
  });
  cancelProgressState("req-1", "user aborted");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.activeToolActivity).toBeUndefined();
  expect(state?.lastToolPreview).toBeUndefined();
});

test("getAllProgressStates returns all states sorted by startTime desc", () => {
  resetProgressStore();
  createProgressState("sort-a", "agent-a", "task-a");
  createProgressState("sort-b", "agent-b", "task-b");
  createProgressState("sort-c", "agent-c", "task-c");
  const states = getAllProgressStates();
  expect(states).toHaveLength(3);
  const requestIds = states.map((s) => s.requestId);
  // Creation order is a, b, c but startTime may vary slightly.
  // Verify sort is descending: startTime[i] >= startTime[i+1].
  for (let i = 0; i < states.length - 1; i++) {
    const a = states[i];
    const b = states[i + 1];
    if (a && b) {
      expect(a.startTime).toBeGreaterThanOrEqual(b.startTime);
    }
  }
  // All expected request ids are present.
  expect(requestIds).toContain("sort-a");
  expect(requestIds).toContain("sort-b");
  expect(requestIds).toContain("sort-c");
  resetProgressStore();
});

test("emitted progress preview truncation remains at 120 characters", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: `bash: ${"y".repeat(150)}` }],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBeDefined();
  if (result.lastToolPreview) {
    expect(Array.from(result.lastToolPreview).length).toBe(120);
    expect(result.lastToolPreview).toEndWith("…");
  }
});

test("isToolCallPart rejects non-objects", () => {
  expect(isToolCallPart(null)).toBe(false);
  expect(isToolCallPart(undefined)).toBe(false);
  expect(isToolCallPart(42)).toBe(false);
  expect(isToolCallPart("string")).toBe(false);
  expect(isToolCallPart(true)).toBe(false);
});

test("isToolCallPart rejects objects missing required fields", () => {
  expect(isToolCallPart({})).toBe(false);
  expect(isToolCallPart({ type: "text" })).toBe(false);
  expect(isToolCallPart({ type: "toolCall" })).toBe(false);
  expect(isToolCallPart({ type: "toolCall", id: "tc-1" })).toBe(false);
  expect(isToolCallPart({ type: "toolCall", id: "tc-1", name: 42 })).toBe(
    false,
  );
  expect(isToolCallPart({ type: "toolCall", id: 42, name: "bash" })).toBe(
    false,
  );
});

test("isToolCallPart accepts valid tool call parts", () => {
  expect(
    isToolCallPart({
      type: "toolCall",
      id: "tc-1",
      name: "bash",
      arguments: { command: "ls" },
    }),
  ).toBe(true);
  expect(isToolCallPart({ type: "toolCall", id: "tc-2", name: "read" })).toBe(
    true,
  );
});

test("extractProgressFromDetails skips non-object entries in derived toolCalls", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "test",
        agentSource: "user",
        task: "task",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        progress: {
          toolCalls: [
            null,
            42,
            "string",
            { id: "valid-1", preview: "bash: ls" },
            { id: false, preview: "bad" },
            { id: "bad", preview: 123 },
          ] as unknown as { id: string; preview: string }[],
        },
      },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["valid-1"]);
  expect(result.lastToolPreview).toBe("bash: ls");
});

test("extractProgressFromDetails handles toolResultCompleted and activeToolActivity in progress", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "test",
        agentSource: "user",
        task: "task",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        progress: {
          toolCalls: [],
          activityText: "bash: running",
          lastToolPreview: "bash: running",
          toolResultCompleted: true,
          activeToolActivity: {
            toolName: "bash",
            inputSummary: "bash: running",
          },
        },
      },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("bash: running");
  expect(result.lastToolPreview).toBe("bash: running");
  expect(result.toolResultCompleted).toBe(true);
  expect(result.activeToolActivity).toEqual({
    toolName: "bash",
    inputSummary: "bash: running",
  });
});

test("extractProgressFromDetails skips non-assistant messages and non-array content", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "test",
        agentSource: "user",
        task: "task",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: null },
          { role: "assistant", content: "not-an-array" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "hello" },
              {
                type: "toolCall",
                id: "tc-1",
                name: "bash",
                arguments: { command: "ls" },
              },
            ],
          },
        ] as unknown as Message[],
      },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("extractProgressFromDetails blank activityText with valid tool calls uses tool-call preview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-1", preview: "bash: ls" },
      { id: "tc-2", preview: "read: /tmp/file" },
    ],
    activityText: "   ",
    lastToolPreview: "read: /tmp/file",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
  expect(result.lastToolPreview).toBe("read: /tmp/file");
  expect(result.newToolCallIds).toEqual(["tc-1", "tc-2"]);
  expect(result.progressLastToolPreview).toBe("read: /tmp/file");
});

test("extractProgressFromDetails preview-only progress with tool calls sets progressLastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: echo hello" }],
    lastToolPreview: "bash: echo hello",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBe("bash: echo hello");
  expect(result.lastToolPreview).toBe("bash: echo hello");
  expect(result.activityText).toBeUndefined();
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("extractProgressFromDetails empty toolCalls with lastToolPreview sets lastToolPreview via fallback", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    lastToolPreview: "bash: stale preview",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("bash: stale preview");
  expect(result.progressLastToolPreview).toBe("bash: stale preview");
  expect(result.newToolCallIds).toEqual([]);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails non-string activityText with valid tool calls ignores activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: 42 as unknown as string,
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("extractProgressFromDetails progress with only toolResultCompleted sets completion flag", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.toolResultCompleted).toBe(true);
  expect(result.activityText).toBeUndefined();
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.newToolCallIds).toEqual([]);
});

test("extractProgressFromDetails multiple results with mixed progress and messages", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "agent-a",
        agentSource: "user",
        task: "task a",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        progress: {
          toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
          activityText: "running ls",
          lastToolPreview: "bash: ls",
        },
      },
      {
        agent: "agent-b",
        agentSource: "user",
        task: "task b",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc-2",
                name: "read",
                arguments: { path: "/tmp/file" },
              },
            ],
          },
        ] as unknown as Message[],
      },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  // tc-1 from first result progress; tc-2 from second result messages
  expect(result.newToolCallIds).toEqual(["tc-1", "tc-2"]);
  expect(result.activityText).toBe("running ls");
  // lastToolPreview is set by the last valid tool call processed
  expect(result.lastToolPreview).toBe("read: /tmp/file");
  // progressLastToolPreview is set from the first result's progress.lastToolPreview
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect([...seen]).toEqual(["tc-1", "tc-2"]);
});

test("extractProgressFromDetails falsy progress on result falls through to messages", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-msg",
          name: "bash",
          arguments: { command: "echo hi" },
        },
      ],
    },
  ]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  (firstResult as unknown as { progress: unknown }).progress = false;
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-msg"]);
  expect(result.lastToolPreview).toBe("bash: echo hi");
});

test("extractProgressFromDetails valid progress populates all derived fields", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-1", preview: "bash: build" },
      { id: "tc-2", preview: "read: output.log" },
    ],
    activityText: "Building project",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: { toolName: "bash", inputSummary: "bash: build" },
    },
    lastToolPreview: "read: output.log",
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("Building project");
  expect(result.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    child: { toolName: "bash", inputSummary: "bash: build" },
  });
  expect(result.lastToolPreview).toBe("read: output.log");
  expect(result.progressLastToolPreview).toBe("read: output.log");
  expect(result.toolResultCompleted).toBe(true);
  expect(result.newToolCallIds).toEqual(["tc-1", "tc-2"]);
  expect([...seen]).toEqual(["tc-1", "tc-2"]);
});

test("extractProgressFromDetails does not set activityText for whitespace-only string", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [], activityText: "   " };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails does not set progressLastToolPreview for whitespace-only lastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [], lastToolPreview: "   " };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBeUndefined();
  expect(result.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails skips null entries in toolCalls", () => {
  const details = makeDetails([]) as unknown as SubagentDetails;
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [null, { id: "tc-1", preview: "bash: ls" }] as unknown as {
      id: string;
      preview: string;
    }[],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-1"]);
  expect(result.lastToolPreview).toBe("bash: ls");
});

test("extractProgressFromDetails sets lastToolPreview from progress.lastToolPreview when toolCalls has no derivable entries", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [], lastToolPreview: "bash: ls" };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual([]);
});

test("finalizeProgressState prefers outcome parameter when supplied", () => {
  createProgressState("req-out-1", "agent-x", "task-x");
  finalizeProgressState(
    "req-out-1",
    "raw final output noise",
    "Actual typed outcome!",
  );
  expect(getProgressState("req-out-1")?.finalOutput).toBe(
    "actual typed outcome",
  );
});

test("finalizeProgressState falls back to finalOutput when outcome parameter is absent or blank", () => {
  createProgressState("req-out-2", "agent-x", "task-x");
  finalizeProgressState("req-out-2", "Outcome: Parsed text fallback", "");
  expect(getProgressState("req-out-2")?.finalOutput).toBe(
    "outcome: parsed text fallback",
  );

  createProgressState("req-out-3", "agent-x", "task-x");
  finalizeProgressState(
    "req-out-3",
    "Outcome: Parsed text fallback",
    undefined,
  );
  expect(getProgressState("req-out-3")?.finalOutput).toBe(
    "outcome: parsed text fallback",
  );
});

const realDateNow = Date.now;

afterEach(() => {
  Date.now = realDateNow;
  resetProgressStore();
});

function setDateNow(now: number): void {
  Date.now = () => now;
}

function makeTheme() {
  return {
    fg: (_color: ThemeColor, text: string) => text,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => text,
  };
}

function renderText(
  rendered: { render(width: number): string[] } | undefined,
): string {
  return renderLines(rendered).join("\n");
}

function renderLines(
  rendered: { render(width: number): string[] } | undefined,
): string[] {
  if (!rendered) return [];
  return rendered.render(120);
}

function makeDetails(
  messages: { role: string; content: unknown[]; usage?: unknown }[],
): SubagentDetails {
  return {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "test-agent",
        agentSource: "user",
        task: "test task",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        messages: messages as unknown as Message[],
      },
    ],
  };
}
