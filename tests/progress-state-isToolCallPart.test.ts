import { describe, expect, test } from "bun:test";
import { isToolCallPart } from "../src/progress/progress-state.js";

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
