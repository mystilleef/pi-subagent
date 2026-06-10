import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { findLastAssistantTextMessage } from "../src/shared/utils.js";

/** Build a minimal assistant message with given content items. */
function assistantMessage(content: unknown[]): Message {
  return {
    role: "assistant",
    content: content as Message extends { role: "assistant" }
      ? Message["content"]
      : never,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-3-5-sonnet-latest",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as Message;
}

function userMessage(): Message {
  return {
    role: "user",
    content: [],
    timestamp: Date.now(),
  } as unknown as Message;
}

function toolResultMessage(isError = false): Message {
  return {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "test",
    content: [],
    isError,
    timestamp: Date.now(),
  } as unknown as Message;
}

describe("findLastAssistantTextMessage", () => {
  test("empty array returns -1", () => {
    expect(findLastAssistantTextMessage([])).toBe(-1);
  });

  test("no assistant messages returns -1", () => {
    const msgs: Message[] = [userMessage(), userMessage()];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("only toolResult messages returns -1", () => {
    const msgs: Message[] = [toolResultMessage(), toolResultMessage(true)];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("all assistant messages with empty text returns -1", () => {
    const msgs: Message[] = [assistantMessage([{ type: "text", text: "" }])];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("all assistant messages with whitespace-only text returns -1", () => {
    const msgs: Message[] = [assistantMessage([{ type: "text", text: "   " }])];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("single element — assistant with non-empty text returns 0", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "hello" }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(0);
  });

  test("single element — assistant with empty text returns -1", () => {
    const msgs: Message[] = [assistantMessage([{ type: "text", text: "" }])];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("single element — non-assistant returns -1", () => {
    const msgs: Message[] = [userMessage()];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("last element is the target", () => {
    const msgs: Message[] = [
      userMessage(),
      assistantMessage([{ type: "text", text: "hello" }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(1);
  });

  test("multiple candidates — last matching one wins", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "first" }]),
      assistantMessage([{ type: "text", text: "" }]),
      assistantMessage([{ type: "text", text: "last" }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(2);
  });

  test("multiple candidates — later empty doesn't override earlier valid", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "valid" }]),
      assistantMessage([{ type: "text", text: "" }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(0);
  });

  test("assistant with mixed content — text takes precedence over tool calls", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "toolCall", id: "tc1", name: "t", arguments: {} },
        { type: "text", text: "result" },
      ]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(0);
  });

  test("assistant with only tool calls — returns -1", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "toolCall", id: "tc1", name: "t", arguments: {} },
      ]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("assistant with only thinking content — returns -1", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "thinking", thinking: "deep thoughts" }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("whitespace-only treated as empty (tab, newline, spaces)", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "\t\n  " }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("text with surrounding whitespace — trims and finds text", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "  hello world  " }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(0);
  });

  test("handles null text without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: null } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles undefined text without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text" } as unknown as { type: string; text: string },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles non-string text (number) without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: 42 } as unknown as { type: string; text: string },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles non-string text (boolean) without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: true } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles non-string text (object) without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: { foo: "bar" } } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles non-string text (array) without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: ["a"] } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("interleaved roles — only assistant messages considered", () => {
    const msgs: Message[] = [
      userMessage(),
      assistantMessage([{ type: "text", text: "first" }]),
      toolResultMessage(),
      userMessage(),
      assistantMessage([{ type: "text", text: "second" }]),
      toolResultMessage(true),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(4);
  });

  test("assistant message with no content property returns -1", () => {
    const msgs = [{ role: "assistant" } as unknown as Message];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("assistant message with null content returns -1", () => {
    const msgs = [{ role: "assistant", content: null } as unknown as Message];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("assistant message with undefined content returns -1", () => {
    const msgs = [
      { role: "assistant", content: undefined } as unknown as Message,
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });
});
