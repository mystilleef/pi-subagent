import { expect, test } from "bun:test";
import { resolveThinkingLevel } from "../src/child/process.js";

test("passthrough when model not in registry", () => {
  const result = resolveThinkingLevel(
    "high",
    "unknown-provider",
    "unknown-model",
  );
  expect(result).toEqual({ level: "high" });
  expect(result.warning).toBeUndefined();
});

test("clamps to off when reasoning is false", () => {
  const result = resolveThinkingLevel("high", "openai", "gpt-4o");
  expect(result).toEqual({
    level: "off",
    warning:
      'Thinking level "high" not supported by model "openai/gpt-4o"; using "off" instead',
  });
});

test("passthrough when no thinkingLevelMap and reasoning is true", () => {
  const result = resolveThinkingLevel(
    "high",
    "anthropic",
    "claude-sonnet-4-20250514",
  );
  expect(result).toEqual({ level: "high" });
  expect(result.warning).toBeUndefined();
});

test("passthrough when no thinkingLevelMap and requested level is xhigh", () => {
  const result = resolveThinkingLevel(
    "xhigh",
    "anthropic",
    "claude-sonnet-4-20250514",
  );
  expect(result).toEqual({ level: "xhigh" });
  expect(result.warning).toBeUndefined();
});

test("returns as-is when level supported via thinkingLevelMap", () => {
  const result = resolveThinkingLevel("medium", "openai", "gpt-5");
  expect(result).toEqual({ level: "medium" });
  expect(result.warning).toBeUndefined();
});

test("clamps xhigh down and warns when not in thinkingLevelMap", () => {
  const result = resolveThinkingLevel("xhigh", "openai", "gpt-5");
  expect(result).toEqual({
    level: "high",
    warning:
      'Thinking level "xhigh" not supported by model "openai/gpt-5"; using "high" instead',
  });
});

test("clamps off up and warns when null in thinkingLevelMap", () => {
  const result = resolveThinkingLevel("off", "openai", "gpt-5");
  expect(result).toEqual({
    level: "minimal",
    warning:
      'Thinking level "off" not supported by model "openai/gpt-5"; using "minimal" instead',
  });
});

test("no warning when all levels supported via thinkingLevelMap", () => {
  const result = resolveThinkingLevel("xhigh", "openai", "gpt-5.2");
  expect(result).toEqual({ level: "xhigh" });
  expect(result.warning).toBeUndefined();
});
