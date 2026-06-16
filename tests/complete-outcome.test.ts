import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  getLatestOutcomeFromMessages,
  getOutcomeString,
} from "../src/child/complete-outcome.js";

function msg(partial: Record<string, unknown>): Message {
  return partial as unknown as Message;
}

function assistant(content: unknown): Message {
  return msg({ role: "assistant", content });
}

function toolResult(overrides: Record<string, unknown>): Message {
  return msg({ role: "toolResult", ...overrides });
}

describe("getOutcomeString", () => {
  test("returns trimmed outcome from valid source", () => {
    expect(getOutcomeString({ outcome: "Great success" })).toBe(
      "Great success",
    );
  });

  test("trims whitespace from outcome", () => {
    expect(getOutcomeString({ outcome: "  padded outcome  " })).toBe(
      "padded outcome",
    );
  });

  test("returns undefined for null source", () => {
    expect(getOutcomeString(null)).toBeUndefined();
  });

  test("returns undefined for undefined source", () => {
    expect(getOutcomeString(undefined)).toBeUndefined();
  });

  test("returns undefined for non-object source", () => {
    expect(getOutcomeString("string")).toBeUndefined();
    expect(getOutcomeString(42)).toBeUndefined();
    expect(getOutcomeString(true)).toBeUndefined();
    expect(getOutcomeString([])).toBeUndefined();
  });

  test("returns undefined when outcome property is not a string", () => {
    expect(getOutcomeString({ outcome: 123 })).toBeUndefined();
    expect(getOutcomeString({ outcome: true })).toBeUndefined();
    expect(getOutcomeString({ outcome: null })).toBeUndefined();
    expect(getOutcomeString({ outcome: {} })).toBeUndefined();
    expect(getOutcomeString({ outcome: [] })).toBeUndefined();
  });

  test("returns undefined for missing outcome property", () => {
    expect(getOutcomeString({})).toBeUndefined();
    expect(getOutcomeString({ other: "value" })).toBeUndefined();
  });

  test("returns undefined for whitespace-only outcome", () => {
    expect(getOutcomeString({ outcome: "   " })).toBeUndefined();
    expect(getOutcomeString({ outcome: "\n" })).toBeUndefined();
    expect(getOutcomeString({ outcome: "\t\r\n" })).toBeUndefined();
  });

  test("returns undefined for empty string outcome", () => {
    expect(getOutcomeString({ outcome: "" })).toBeUndefined();
  });

  test("returns single character outcome", () => {
    expect(getOutcomeString({ outcome: "a" })).toBe("a");
  });
});

describe("getLatestOutcomeFromMessages", () => {
  test("returns undefined for undefined messages", () => {
    expect(getLatestOutcomeFromMessages(undefined)).toBeUndefined();
  });

  test("returns undefined for empty messages array", () => {
    expect(getLatestOutcomeFromMessages([])).toBeUndefined();
  });

  test("returns undefined when no complete calls exist", () => {
    const messages: Message[] = [
      assistant([{ type: "text", text: "No complete here" }]),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBeUndefined();
  });

  test("extracts outcome from toolResult details", () => {
    const messages: Message[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: { outcome: "From arguments" },
        },
      ]),
      toolResult({
        toolCallId: "call-1",
        details: { outcome: "From details" },
      }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("From details");
  });

  test("falls back to assistant arguments when toolResult has no outcome details", () => {
    const messages: Message[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: { outcome: "Fallback outcome" },
        },
      ]),
      toolResult({ toolCallId: "call-1", details: {} }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("Fallback outcome");
  });

  test("falls back to assistant arguments when toolResult details is missing", () => {
    const messages: Message[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: { outcome: "Only in args" },
        },
      ]),
      toolResult({ toolCallId: "call-1" }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("Only in args");
  });

  test("skips errored toolResult and uses earlier valid outcome", () => {
    const messages: Message[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: { outcome: "First valid" },
        },
      ]),
      toolResult({
        toolCallId: "call-1",
        details: { outcome: "First valid" },
      }),
      assistant([
        {
          type: "toolCall",
          id: "call-2",
          name: "complete",
          arguments: { outcome: "Second errored" },
        },
      ]),
      toolResult({
        toolCallId: "call-2",
        isError: true,
        details: { outcome: "Second errored" },
      }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("First valid");
  });

  test("uses latest valid complete call when multiple exist", () => {
    const messages: Message[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: { outcome: "First outcome" },
        },
      ]),
      toolResult({
        toolCallId: "call-1",
        details: { outcome: "First outcome" },
      }),
      assistant([
        {
          type: "toolCall",
          id: "call-2",
          name: "complete",
          arguments: { outcome: "Second outcome" },
        },
      ]),
      toolResult({
        toolCallId: "call-2",
        details: { outcome: "Second outcome" },
      }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("Second outcome");
  });

  test("ignores toolResult without matching complete call", () => {
    const messages: Message[] = [
      toolResult({
        toolCallId: "orphan-call",
        details: { outcome: "Orphaned outcome" },
      }),
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: { outcome: "Valid outcome" },
        },
      ]),
      toolResult({
        toolCallId: "call-1",
        details: { outcome: "Valid outcome" },
      }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("Valid outcome");
  });

  test("returns undefined when complete toolResult has no outcome and call has none", () => {
    const messages: Message[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: {},
        },
      ]),
      toolResult({ toolCallId: "call-1", details: {} }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBeUndefined();
  });

  test("ignores non-complete tool calls", () => {
    const messages: Message[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { outcome: "Not complete" },
        },
      ]),
      assistant([
        {
          type: "toolCall",
          id: "call-2",
          name: "complete",
          arguments: { outcome: "Real complete" },
        },
      ]),
      toolResult({
        toolCallId: "call-2",
        details: { outcome: "Real complete" },
      }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("Real complete");
  });

  test("handles assistant messages with non-array content", () => {
    const messages: Message[] = [
      msg({ role: "assistant", content: "plain text" }),
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: { outcome: "Valid outcome" },
        },
      ]),
      toolResult({
        toolCallId: "call-1",
        details: { outcome: "Valid outcome" },
      }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("Valid outcome");
  });

  test("handles complete call with whitespace-only outcome in arguments", () => {
    const messages: Message[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: { outcome: "   " },
        },
      ]),
      toolResult({
        toolCallId: "call-1",
        details: { outcome: "Real from details" },
      }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("Real from details");
  });

  test("toolResult with id field instead of toolCallId still matches", () => {
    const messages: Message[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "complete",
          arguments: { outcome: "Outcome via id" },
        },
      ]),
      msg({
        role: "toolResult",
        id: "call-1",
        details: { outcome: "Outcome via id" },
      }),
    ];
    expect(getLatestOutcomeFromMessages(messages)).toBe("Outcome via id");
  });
});
