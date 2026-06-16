import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "../src/agent/agents.js";
import {
  buildModelDisplay,
  resolveEffectiveChildModelSettings,
  resolveThinkingLevel,
} from "../src/child/model-resolution.js";

describe("resolveEffectiveChildModelSettings", () => {
  test("uses agent provider and model when both provided", () => {
    const agent = { provider: "openai", model: "gpt-4" };
    const result = resolveEffectiveChildModelSettings(agent, undefined);
    expect(result).toEqual({ provider: "openai", id: "gpt-4" });
  });

  test("falls back to parent provider when agent provider is missing", () => {
    const agent = { model: "gpt-4" };
    const parent = { provider: "anthropic", id: "claude-sonnet" };
    const result = resolveEffectiveChildModelSettings(agent, parent);
    expect(result).toEqual({ provider: "anthropic", id: "gpt-4" });
  });

  test("falls back to parent model when agent model is missing and agent provider is missing", () => {
    const agent = {};
    const parent = { provider: "openai", id: "gpt-4" };
    const result = resolveEffectiveChildModelSettings(agent, parent);
    expect(result).toEqual({ provider: "openai", id: "gpt-4" });
  });

  test("does not inherit parent model when agent provides its own provider but no model", () => {
    const agent = { provider: "openai" };
    const parent = { provider: "anthropic", id: "claude-sonnet" };
    const result = resolveEffectiveChildModelSettings(agent, parent);
    expect(result).toEqual({ provider: "openai", id: undefined });
  });

  test("returns empty settings when nothing is provided", () => {
    const agent = {};
    const result = resolveEffectiveChildModelSettings(agent, undefined);
    expect(result).toEqual({ provider: undefined, id: undefined });
  });

  test("agent provider overrides parent provider", () => {
    const agent = { provider: "google" };
    const parent = { provider: "openai" };
    const result = resolveEffectiveChildModelSettings(agent, parent);
    expect(result).toEqual({ provider: "google", id: undefined });
  });

  test("agent model overrides parent model when no agent provider", () => {
    const agent = { model: "gemini-pro" };
    const parent = { provider: "openai", id: "gpt-4" };
    const result = resolveEffectiveChildModelSettings(agent, parent);
    expect(result).toEqual({ provider: "openai", id: "gemini-pro" });
  });

  test("handles agent with provider as undefined explicitly", () => {
    const agent = { provider: undefined, model: "gpt-4" };
    const parent = { provider: "anthropic", id: "claude-sonnet" };
    const result = resolveEffectiveChildModelSettings(agent, parent);
    expect(result).toEqual({ provider: "anthropic", id: "gpt-4" });
  });
});

describe("buildModelDisplay", () => {
  test("builds full display with provider, id, and thinking", () => {
    const result = buildModelDisplay(
      { provider: "openai", id: "gpt-4" },
      "medium" as ThinkingLevel,
    );
    expect(result).toBe("openai ･ gpt-4 ･ medium");
  });

  test("returns provider and thinking when id is missing", () => {
    const result = buildModelDisplay(
      { provider: "openai" },
      "high" as ThinkingLevel,
    );
    expect(result).toBe("openai ･ high");
  });

  test("returns provider and id when thinking is falsy", () => {
    const result = buildModelDisplay(
      { provider: "openai", id: "gpt-4" },
      "" as ThinkingLevel,
    );
    expect(result).toBe("openai ･ gpt-4");
  });

  test("returns only provider when id and thinking are missing", () => {
    const result = buildModelDisplay(
      { provider: "openai" },
      "" as ThinkingLevel,
    );
    expect(result).toBe("openai");
  });

  test("returns only thinking when provider and id are missing", () => {
    const result = buildModelDisplay({}, "low" as ThinkingLevel);
    expect(result).toBe("low");
  });

  test("returns only id when provider is missing", () => {
    const result = buildModelDisplay({ id: "gpt-4" }, "" as ThinkingLevel);
    expect(result).toBe("gpt-4");
  });

  test("returns undefined when all parts are empty", () => {
    const result = buildModelDisplay({}, "" as ThinkingLevel);
    expect(result).toBeUndefined();
  });

  test("returns undefined when effectiveModel is empty and thinking is empty string", () => {
    const result = buildModelDisplay(
      { provider: undefined, id: undefined },
      "" as ThinkingLevel,
    );
    expect(result).toBeUndefined();
  });

  test("handles thinking level off", () => {
    const result = buildModelDisplay(
      { provider: "openai", id: "gpt-4" },
      "off" as ThinkingLevel,
    );
    expect(result).toBe("openai ･ gpt-4 ･ off");
  });
});

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
  });

  test("returns off with warning when supported levels only contain off", () => {
    const result = resolveThinkingLevel("low", "openai", "gpt-4-turbo");
    expect(result.level).toBe("off");
    expect(result.warning).toContain("not supported by model");
  });

  test("returns warning when reasoning is false and requested is already off", () => {
    const result = resolveThinkingLevel("off", "openai", "gpt-4");
    expect(result.level).toBe("off");
    expect(result.warning).toContain("not supported by model");
  });

  test("returns requested level for model with matching supported level", () => {
    const result = resolveThinkingLevel(
      "high",
      "anthropic",
      "claude-3-7-sonnet-20250219",
    );
    expect(result.level).toBe("high");
    expect(result.warning).toBeUndefined();
  });

  test("returns requested level when thinkingLevelMap is undefined and reasoning is true", () => {
    const result = resolveThinkingLevel(
      "medium",
      "anthropic",
      "claude-3-7-sonnet-20250219",
    );
    expect(result.level).toBe("medium");
    expect(result.warning).toBeUndefined();
  });

  test("clamps unsupported level with warning when model has thinkingLevelMap", () => {
    const result = resolveThinkingLevel("off", "openai", "gpt-5");
    expect(result.level).toBe("minimal");
    expect(result.warning).toContain('using "minimal" instead');
  });

  test("clamps out-of-range high to supported maximum", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-5");
    expect(result.level).toBe("high");
    expect(result.warning).toBeUndefined();
  });

  test("returns clamped level warning for unsupported thinking level", () => {
    const result = resolveThinkingLevel("off", "openai", "gpt-5");
    expect(result.warning).toContain("not supported by model");
    expect(result.warning).toContain("openai/gpt-5");
    expect(result.warning).toContain('using "minimal" instead');
  });
});
