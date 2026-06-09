import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { extractProgressFromDetails } from "../src/progress/progress-state.js";
import type { SingleResult, SubagentDetails } from "../src/shared/types.js";

function makeSingleResult(partial: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "test",
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
    ...partial,
  };
}

describe("progress-state.ts coverage gaps", () => {
  describe("extractProgressFromExistingProgress edge cases", () => {
    test("progress with activeToolActivity sets activeToolActivity in state", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
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
            messages: [],
            progress: {
              toolCalls: [{ id: "tc-1", preview: "read: file1" }],
              activityText: "Reading file1",
            },
          }),
          makeSingleResult({
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
