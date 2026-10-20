import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { RuntimeResult } from "../src/child/result-builder.js";
import {
  addMessageToResult,
  initRuntimeResult,
  rebuildResultFromMessages,
} from "../src/child/result-builder.js";
import { TOOL_RESULT_FAILED_MESSAGE } from "../src/shared/types.js";
import { setupHooks } from "./helpers.js";

setupHooks();

describe("runtime finalOutput construction invariants", () => {
  function makeResult(model?: string): RuntimeResult {
    return initRuntimeResult("agent", "user", "task", model ?? "display-model");
  }

  function makeTextMessage(text: string): Message {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
    } as unknown as Message;
  }

  function makeToolCallMessage(
    name: string,
    args: Record<string, unknown>,
  ): Message {
    return {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-1", name, arguments: args }],
    } as unknown as Message;
  }

  function makeToolResultMessage(isError: boolean): Message {
    return {
      role: "toolResult",
      toolCallId: "tc-1",
      isError,
      content: [{ type: "text", text: "tool output" }],
    } as unknown as Message;
  }

  test("initRuntimeResult starts with empty finalOutput", () => {
    const result = makeResult();
    expect(result.finalOutput).toBe("");
    expect(result.messages).toHaveLength(0);
  });

  test("addMessageToResult updates finalOutput from assistant text", () => {
    const result = makeResult();
    addMessageToResult(result, makeTextMessage("first"));
    expect(result.finalOutput).toBe("first");
    addMessageToResult(result, makeTextMessage("second"));
    expect(result.finalOutput).toBe("second");
  });

  test("addMessageToResult updates finalOutput when assistant text follows a tool call", () => {
    const result = makeResult();
    addMessageToResult(result, makeToolCallMessage("bash", { command: "ls" }));
    expect(result.finalOutput).toBe("");
    addMessageToResult(result, makeTextMessage("done"));
    expect(result.finalOutput).toBe("done");
  });

  test("addMessageToResult keeps finalOutput empty for tool-only complete outcome", () => {
    const result = makeResult();
    addMessageToResult(
      result,
      makeToolCallMessage("complete", { outcome: "Completed" }),
    );
    expect(result.finalOutput).toBe("");
    addMessageToResult(result, makeToolResultMessage(false));
    expect(result.finalOutput).toBe("");
  });

  test("addMessageToResult truncates finalOutput to configured output limits", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_LINES = "2";
    process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES = "100000";
    try {
      const result = makeResult();
      const long = "line1\nline2\nline3";
      addMessageToResult(result, makeTextMessage(long));
      expect(result.finalOutput).toContain("[TRUNCATED:");
      expect(result.finalOutput).toContain("line1");
      expect(result.finalOutput).not.toContain("line3");
    } finally {
      delete process.env.PI_SUBAGENT_MAX_OUTPUT_LINES;
      delete process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES;
    }
  });

  test("addMessageToResult records toolResult errors and assistant error messages", () => {
    const result = makeResult();
    addMessageToResult(result, makeToolResultMessage(true));
    expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
    addMessageToResult(result, makeTextMessage("retry") as unknown as Message);
    expect(result.errorMessage).toBeUndefined();
    addMessageToResult(result, {
      role: "assistant",
      content: [{ type: "text", text: "api error" }],
      errorMessage: "provider error",
    } as unknown as Message);
    expect(result.errorMessage).toBe("provider error");
  });

  test("rebuildResultFromMessages replaces stale finalOutput with newer assistant text", () => {
    const result = makeResult();
    addMessageToResult(result, makeTextMessage("stale"));
    rebuildResultFromMessages(result, [makeTextMessage("authoritative")]);
    expect(result.finalOutput).toBe("authoritative");
    expect(result.messages).toHaveLength(1);
  });

  test("rebuildResultFromMessages refreshes usage, stopReason, and errorMessage", () => {
    const result = makeResult();
    const stale = {
      role: "assistant",
      content: [{ type: "text", text: "stale" }],
      usage: {
        input: 100,
        output: 200,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 300,
        cost: { total: 9 },
      },
      stopReason: "length",
      errorMessage: "stale error",
    } as unknown as Message;
    const authoritative = {
      role: "assistant",
      content: [{ type: "text", text: "authoritative" }],
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 6,
        cost: { total: 0.7 },
      },
      stopReason: "error",
      errorMessage: "final error",
    } as unknown as Message;
    addMessageToResult(result, stale);
    rebuildResultFromMessages(result, [authoritative]);
    expect(result.finalOutput).toBe("authoritative");
    expect(result.usage.input).toBe(2);
    expect(result.usage.output).toBe(3);
    expect(result.usage.cacheRead).toBe(4);
    expect(result.usage.cacheWrite).toBe(5);
    expect(result.usage.cost).toBe(0.7);
    expect(result.usage.contextTokens).toBe(6);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("final error");
  });

  test("rebuildResultFromMessages with empty messages clears finalOutput and errors", () => {
    const result = makeResult();
    addMessageToResult(result, makeTextMessage("stale"));
    addMessageToResult(result, makeToolResultMessage(true));
    rebuildResultFromMessages(result, []);
    expect(result.finalOutput).toBe("");
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBeUndefined();
    expect(result.messages).toHaveLength(0);
  });
});
