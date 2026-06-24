import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { extractFinalOutputFromMessages } from "../src/shared/utils.js";

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

describe("extractFinalOutputFromMessages", () => {
  // ── Happy path ────────────────────────────────────────────────

  test("returns last text part from last assistant message with valid text", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "hello" }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("hello");
  });

  test("returns last text part in mixed content (text + tool calls)", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
        { type: "text", text: "result" },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("result");
  });

  test("returns last text part when earlier text parts precede tool calls", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "starting" },
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
        { type: "text", text: "done" },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("done");
  });

  test("returns text from last assistant when multiple assistants exist", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "first" }]),
      assistantMessage([{ type: "text", text: "second" }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("second");
  });

  test("returns text with surrounding whitespace as-is (not trimmed)", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "  hello world  " }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("  hello world  ");
  });

  // ── Null / undefined text — nullish coalescing ────────────────

  test("returns empty string when text is null", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: null } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when text is undefined", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text" } as unknown as { type: string; text: string },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when last text part has null text but earlier part has valid text", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "valid" },
        {
          type: "text",
          text: null,
        } as unknown as { type: string; text: string },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  // ── Non-string text — typeof guard rejects in some() ──────────

  test("returns empty string when text is a number", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: 42 } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when text is a boolean", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: true } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when text is an object", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: { foo: "bar" } } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when text is an array", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: ["a"] } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  // ── Whitespace-only / empty text ──────────────────────────────

  test("returns empty string when all text parts are empty", () => {
    const msgs: Message[] = [assistantMessage([{ type: "text", text: "" }])];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when all text parts are whitespace-only", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "   \n \t  " }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when message has only whitespace-only and empty text parts", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "\t  " },
        { type: "text", text: "" },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns whitespace text as-is when message has one valid text part and the last text part is whitespace", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "valid" },
        { type: "text", text: "   " },
      ]),
    ];
    // The some() check matches the message because of "valid".
    // findLast finds the last text part ("   "), which is returned as-is.
    expect(extractFinalOutputFromMessages(msgs)).toBe("   ");
  });

  // ── Non-array / missing content ───────────────────────────────

  test("returns empty string when content is not an array", () => {
    const msgs = [
      { role: "assistant", content: "plain string" },
    ] as unknown as Message[];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when content is null", () => {
    const msgs = [{ role: "assistant", content: null }] as unknown as Message[];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when content is undefined", () => {
    const msgs = [
      { role: "assistant", content: undefined },
    ] as unknown as Message[];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when assistant message has no content property", () => {
    const msgs = [{ role: "assistant" }] as unknown as Message[];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  // ── No valid assistant messages ───────────────────────────────

  test("returns empty string for empty messages array", () => {
    expect(extractFinalOutputFromMessages([])).toBe("");
  });

  test("returns empty string when no assistant messages exist", () => {
    const msgs: Message[] = [userMessage(), userMessage()];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when only toolResult messages exist", () => {
    const msgs: Message[] = [toolResultMessage(), toolResultMessage(true)];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when assistants have only tool calls", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when assistants have only thinking content", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "thinking", thinking: "deep thoughts" }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  // ── Interleaved roles — only assistant messages considered ────

  test("skips non-assistant messages between assistants", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "first" }]),
      userMessage(),
      toolResultMessage(),
      assistantMessage([{ type: "text", text: "last" }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("last");
  });

  test("skips last assistant with only whitespace text and picks earlier valid", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "real output" }]),
      assistantMessage([{ type: "text", text: "   \n  \t" }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("real output");
  });

  test("skips last assistant with only empty text and picks earlier valid", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "real output" }]),
      assistantMessage([{ type: "text", text: "" }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("real output");
  });

  test("skips last assistant with null text and picks earlier valid", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "real output" }]),
      assistantMessage([
        { type: "text", text: null } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("real output");
  });

  test("skips last assistant with non-string text and picks earlier valid", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "real output" }]),
      assistantMessage([
        { type: "text", text: 99 } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("real output");
  });

  // ── Multi-text messages where valid text exists with invalid last part ──

  test("extracts last text part even when earlier part was the qualifying one in some()", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "qualifying" }, // passes some() check
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
        { type: "text", text: "final" }, // returned by findLast
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("final");
  });

  // ── Malformed content parts ───────────────────────────────────

  test("throws when content part is null (cannot access type on null)", () => {
    const msgs: Message[] = [
      assistantMessage([null as unknown as { type: string; text: string }]),
    ];
    expect(() => extractFinalOutputFromMessages(msgs)).toThrow();
  });

  test("returns empty string when content part has no type property", () => {
    const msgs: Message[] = [
      assistantMessage([
        { text: "no type" } as unknown as { type: string; text: string },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });
});
