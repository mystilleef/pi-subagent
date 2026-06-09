import { describe, expect, test } from "bun:test";
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

describe("progress-state.ts extractProgressFromExistingProgress branches", () => {
  describe("activityText normalization", () => {
    test("progress with whitespace-only activityText does not set activityText", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
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
    test("progress with toolResultCompleted true sets flag", () => {
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

    test("progress without toolResultCompleted does not set flag", () => {
      const details: SubagentDetails = {
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
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
