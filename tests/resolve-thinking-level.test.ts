import { describe, expect, test } from "bun:test";
import { resolveThinkingLevel } from "../src/child/process.js";

describe("resolveThinkingLevel", () => {
  test("returns requested level when model not found", () => {
    const result = resolveThinkingLevel("low", "nonexistent", "model-1");
    expect(result).toEqual({ level: "low" });
    expect(result.warning).toBeUndefined();
  });

  test("returns off with warning when model reasoning is false", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4");
    expect(result.level).toBe("off");
    expect(result.warning).toContain("not supported by model");
    expect(result.warning).toContain("openai/gpt-4");
    expect(result.warning).toContain('using "off" instead');
  });

  test("returns off with warning when model has no thinkingLevelMap and reasoning false", () => {
    const result = resolveThinkingLevel("medium", "openai", "gpt-4o");
    expect(result.level).toBe("off");
    expect(result.warning).toContain("not supported by model");
    expect(result.warning).toContain('using "off" instead');
  });

  test("returns off with warning when supported levels only contain off", () => {
    const result = resolveThinkingLevel("low", "openai", "gpt-4-turbo");
    expect(result.level).toBe("off");
    expect(result.warning).toContain("not supported by model");
  });

  test("returns requested level when clamped equals requested", () => {
    const result = resolveThinkingLevel("off", "openai", "gpt-4");
    expect(result.level).toBe("off");
    expect(result.warning).toContain('using "off" instead');
  });

  test("returns clamped level with warning when different from requested", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4");
    expect(result.level).toBe("off");
    expect(result.warning).toContain("not supported by model");
    expect(result.warning).toContain("openai/gpt-4");
    expect(result.warning).toContain('using "off" instead');
  });

  test("returns requested level for model with thinkingLevelMap and matching clamp", () => {
    const result = resolveThinkingLevel(
      "high",
      "anthropic",
      "claude-3-7-sonnet-20250219",
    );
    expect(result.level).toBe("high");
    expect(result.warning).toBeUndefined();
  });

  test("returns clamped level with warning for model with thinkingLevelMap", () => {
    const result = resolveThinkingLevel(
      "medium",
      "anthropic",
      "claude-3-7-sonnet-20250219",
    );
    expect(result.level).toBe("medium");
    expect(result.warning).toBeUndefined();
  });

  test("handles all thinking levels", () => {
    const levels = ["off", "low", "medium", "high"] as const;
    for (const level of levels) {
      const result = resolveThinkingLevel(level, "openai", "gpt-4");
      expect(result.level).toBeDefined();
      expect(typeof result.level).toBe("string");
    }
  });

  test("preserves provider and model in warning message", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4");
    if (result.warning) {
      expect(result.warning).toContain("openai");
      expect(result.warning).toContain("gpt-4");
    }
  });
});
