import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "../src/shared/types.js";
import { detectMessageError, hasSubagentFailed } from "../src/shared/utils.js";
import { setupHooks } from "./helpers.js";

setupHooks();

test("hasSubagentFailed is false when outcome is set, even with detectMessageError true", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "running..." }],
    },
    { role: "toolResult", content: [], isError: true },
  ] as unknown as Message[];
  expect(detectMessageError(messages)).toBe(true);
  expect(
    hasSubagentFailed({
      agent: "test",
      agentSource: "user",
      task: "task",
      exitCode: 0,
      stopReason: "toolUse",
      outcome: "Task complete.",
      messages,
      stderr: "",
      finalOutput: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    }),
  ).toBe(false);
});

test("hasSubagentFailed is false when outcome is set despite non-zero exitCode", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ] as unknown as Message[];
  expect(
    hasSubagentFailed({
      agent: "test",
      agentSource: "user",
      task: "task",
      exitCode: 1,
      stopReason: "stop",
      outcome: "Completed anyway.",
      messages,
      stderr: "",
      finalOutput: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    }),
  ).toBe(false);
});

test("detectMessageError is true when error follows the final assistant message", () => {
  expect(
    detectMessageError([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
      },
      { role: "toolResult", content: [], isError: true },
    ] as unknown as Message[]),
  ).toBe(true);
});

test("detectMessageError is false when text assistant message follows error and no subsequent error", () => {
  expect(
    detectMessageError([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
      },
      { role: "toolResult", content: [], isError: true },
      {
        role: "assistant",
        content: [{ type: "text", text: "Recovered." }],
      },
    ] as unknown as Message[]),
  ).toBe(false);
});

describe("utils.ts coverage gaps", () => {
  test("hasSubagentFailed detects various failure conditions", () => {
    expect(hasSubagentFailed({ exitCode: 1 } as unknown as SingleResult)).toBe(
      true,
    );
    expect(
      hasSubagentFailed({
        exitCode: 0,
        stopReason: "error",
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        stopReason: "aborted",
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        errorMessage: "something broke",
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "normal message" }],
            api: "fake",
            provider: "fake",
            model: "fake",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 0,
          },
          {
            role: "toolResult",
            isError: true,
            content: [{ type: "text", text: "error output" }],
          },
        ] as Message[],
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        stopReason: "stop",
        errorMessage: "",
        messages: [],
      } as unknown as SingleResult),
    ).toBe(false);
  });
});

describe("utils.ts coverage gaps", () => {
  test("detectMessageError detects error in messages", () => {
    expect(detectMessageError([])).toBe(false);
    expect(
      detectMessageError([
        {
          role: "assistant",
          content: [{ type: "text", text: "normal message" }],
          api: "fake",
          provider: "fake",
          model: "fake",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      ] as Message[]),
    ).toBe(false);
    expect(
      detectMessageError([
        {
          role: "assistant",
          content: [{ type: "text", text: "normal message" }],
          api: "fake",
          provider: "fake",
          model: "fake",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        },
        {
          role: "toolResult",
          isError: true,
          content: [{ type: "text", text: "error output" }],
        },
      ] as Message[]),
    ).toBe(true);
  });
});
