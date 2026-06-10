import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";

/*
 * Predicate-equivalence tests (R-002, T-001).
 *
 * Verifies whether the inline predicates from findRecentMessagesAnchor
 * and detectMessageError behave identically across all edge cases.
 *
 * Source predicates:
 *   findRecentMessagesAnchor (process.ts:447):
 *     (c) => c.type === "text" && (c as { text?: string }).text?.trim()
 *
 *   detectMessageError (utils.ts:221):
 *     (c) => c.type === "text" && c.text.trim().length > 0
 */

/** Predicate used by findRecentMessagesAnchor (optional-chaining form). */
function findAnchorPredicate(c: unknown): boolean {
  return (
    (c as { type: string }).type === "text" &&
    !!(c as { text?: string }).text?.trim()
  );
}

/** Predicate used by detectMessageError (direct-access form). */
function detectErrorPredicate(c: unknown): boolean {
  return (
    (c as { type: string }).type === "text" &&
    (c as { text: string }).text.trim().length > 0
  );
}

/** Helper: detectMessageError's full first-loop logic. */
function detectMessageErrorFirstLoop(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg?.role === "assistant" &&
      msg.content.some(
        (c) =>
          c.type === "text" && (c as { text: string }).text.trim().length > 0,
      )
    ) {
      return i;
    }
  }
  return -1;
}

/** Helper: findRecentMessagesAnchor's full inline loop. */
function findRecentMessagesAnchorLoop(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg?.role === "assistant" &&
      msg.content.some(
        (c) => c.type === "text" && (c as { text?: string }).text?.trim(),
      )
    ) {
      return i;
    }
  }
  return -1;
}

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

describe("predicate-equivalence", () => {
  describe("individual predicates against single content items", () => {
    test("normal non-empty text — both return true", () => {
      const c = { type: "text", text: "hello" };
      expect(findAnchorPredicate(c)).toBe(true);
      expect(detectErrorPredicate(c)).toBe(true);
      expect(findAnchorPredicate(c)).toBe(detectErrorPredicate(c));
    });

    test("empty string — both return false", () => {
      const c = { type: "text", text: "" };
      expect(findAnchorPredicate(c)).toBe(false);
      expect(detectErrorPredicate(c)).toBe(false);
      expect(findAnchorPredicate(c)).toBe(detectErrorPredicate(c));
    });

    test("whitespace-only string — both return false", () => {
      const c = { type: "text", text: "   " };
      expect(findAnchorPredicate(c)).toBe(false);
      expect(detectErrorPredicate(c)).toBe(false);
      expect(findAnchorPredicate(c)).toBe(detectErrorPredicate(c));
    });

    test("text with surrounding whitespace — both return true", () => {
      const c = { type: "text", text: "  hello  " };
      expect(findAnchorPredicate(c)).toBe(true);
      expect(detectErrorPredicate(c)).toBe(true);
      expect(findAnchorPredicate(c)).toBe(detectErrorPredicate(c));
    });

    test("text with only newlines — both return false", () => {
      const c = { type: "text", text: "\n\n\n" };
      expect(findAnchorPredicate(c)).toBe(false);
      expect(detectErrorPredicate(c)).toBe(false);
      expect(findAnchorPredicate(c)).toBe(detectErrorPredicate(c));
    });

    test("non-text content type — both return false", () => {
      const c = { type: "image", data: "base64" };
      expect(findAnchorPredicate(c)).toBe(false);
      expect(detectErrorPredicate(c)).toBe(false);
      expect(findAnchorPredicate(c)).toBe(detectErrorPredicate(c));
    });

    test("tool call content — both return false", () => {
      const c = { type: "toolCall", id: "tc1", name: "test", arguments: {} };
      expect(findAnchorPredicate(c)).toBe(false);
      expect(detectErrorPredicate(c)).toBe(false);
      expect(findAnchorPredicate(c)).toBe(detectErrorPredicate(c));
    });

    test("thinking content — both return false", () => {
      const c = { type: "thinking", thinking: "deep thoughts" };
      expect(findAnchorPredicate(c)).toBe(false);
      expect(detectErrorPredicate(c)).toBe(false);
      expect(findAnchorPredicate(c)).toBe(detectErrorPredicate(c));
    });
  });

  describe("edge cases: null/undefined/missing text field", () => {
    test("undefined text field — findAnchor safe (falsy), detectError throws", () => {
      const c = { type: "text" } as { type: string; text?: string };
      expect(findAnchorPredicate(c)).toBe(false);
      expect(() => detectErrorPredicate(c)).toThrow();
    });

    test("null text field — findAnchor safe (falsy), detectError throws", () => {
      const c = { type: "text", text: null } as unknown as {
        type: string;
        text: string;
      };
      expect(findAnchorPredicate(c)).toBe(false);
      expect(() => detectErrorPredicate(c)).toThrow();
    });

    test("text as number — both throw (neither handles non-string trim)", () => {
      const c = { type: "text", text: 42 } as unknown as {
        type: string;
        text: string;
      };
      expect(() => findAnchorPredicate(c)).toThrow();
      expect(() => detectErrorPredicate(c)).toThrow();
    });

    test("text as object — both throw", () => {
      const c = { type: "text", text: { foo: "bar" } } as unknown as {
        type: string;
        text: string;
      };
      expect(() => findAnchorPredicate(c)).toThrow();
      expect(() => detectErrorPredicate(c)).toThrow();
    });

    test("text as boolean — both throw", () => {
      const c = { type: "text", text: true } as unknown as {
        type: string;
        text: string;
      };
      expect(() => findAnchorPredicate(c)).toThrow();
      expect(() => detectErrorPredicate(c)).toThrow();
    });

    test("text as array — both throw", () => {
      const c = { type: "text", text: ["a"] } as unknown as {
        type: string;
        text: string;
      };
      expect(() => findAnchorPredicate(c)).toThrow();
      expect(() => detectErrorPredicate(c)).toThrow();
    });
  });

  describe("full loop equivalence", () => {
    test("empty array — both return -1", () => {
      expect(findRecentMessagesAnchorLoop([])).toBe(-1);
      expect(detectMessageErrorFirstLoop([])).toBe(-1);
    });

    test("no assistant messages — both return -1", () => {
      const msgs = [userMessage(), userMessage()];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(-1);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(-1);
    });

    test("assistant with non-empty text — both return its index", () => {
      const msgs: Message[] = [
        assistantMessage([{ type: "text", text: "hello" }]),
      ];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(0);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(0);
    });

    test("assistant with empty text — both return -1", () => {
      const msgs: Message[] = [assistantMessage([{ type: "text", text: "" }])];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(-1);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(-1);
    });

    test("assistant with whitespace-only text — both return -1", () => {
      const msgs: Message[] = [
        assistantMessage([{ type: "text", text: "   " }]),
      ];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(-1);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(-1);
    });

    test("assistant with only non-text content — both return -1", () => {
      const msgs: Message[] = [
        assistantMessage([
          { type: "toolCall", id: "tc1", name: "t", arguments: {} },
        ]),
      ];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(-1);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(-1);
    });

    test("last element is target (reverse iteration)", () => {
      const msgs: Message[] = [
        userMessage(),
        assistantMessage([{ type: "text", text: "hello" }]),
      ];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(1);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(1);
    });

    test("multiple assistant messages — last matching one wins", () => {
      const msgs: Message[] = [
        assistantMessage([{ type: "text", text: "first" }]),
        assistantMessage([{ type: "text", text: "" }]),
        assistantMessage([{ type: "text", text: "second" }]),
      ];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(2);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(2);
    });

    test("assistant with text and tool calls — text one wins", () => {
      const msgs: Message[] = [
        assistantMessage([
          { type: "toolCall", id: "tc1", name: "t", arguments: {} },
          { type: "text", text: "result" },
        ]),
      ];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(0);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(0);
    });

    test("assistant with only tool calls — both return -1", () => {
      const msgs: Message[] = [
        assistantMessage([
          { type: "toolCall", id: "tc1", name: "t", arguments: {} },
          { type: "toolCall", id: "tc2", name: "t2", arguments: {} },
        ]),
      ];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(-1);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(-1);
    });

    test("user after assistant with text — both find the assistant", () => {
      const msgs: Message[] = [
        assistantMessage([{ type: "text", text: "hello" }]),
        userMessage(),
      ];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(0);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(0);
    });

    test("mixed content array with mixed results", () => {
      const msgs: Message[] = [
        userMessage(),
        assistantMessage([
          { type: "toolCall", id: "tc1", name: "t", arguments: {} },
        ]),
        assistantMessage([{ type: "text", text: "valid" }]),
        userMessage(),
      ];
      expect(findRecentMessagesAnchorLoop(msgs)).toBe(2);
      expect(detectMessageErrorFirstLoop(msgs)).toBe(2);
    });
  });
});
