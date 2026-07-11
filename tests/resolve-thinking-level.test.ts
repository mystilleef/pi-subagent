import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "../src/agent/agents.js";
import { resolveThinkingLevel } from "../src/child/model-resolution.js";
import {
  modelFixture,
  registryFixture,
  unsupportedWarning,
} from "./helpers.js";

describe("resolveThinkingLevel", () => {
  test("prefers live registry match over static catalog", () => {
    const live = modelFixture({
      provider: "openai",
      id: "gpt-4",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "medium",
        high: "high",
      },
    });
    const result = resolveThinkingLevel("high", "openai", "gpt-4", {
      registry: registryFixture([live]),
    });
    expect(result.level).toBe("high");
    expect(result.warning).toBeUndefined();
    expect(result.diagnostic).toBeUndefined();
  });

  test("falls back to static catalog when live registry lacks a match", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4", {
      registry: registryFixture([]),
    });
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("high", "off", "openai", "gpt-4"),
    );
  });

  test("emits diagnostic when registry is unavailable and uses static fallback", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4");
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("high", "off", "openai", "gpt-4"),
    );
    expect(result.diagnostic).toBe(
      "Live model registry unavailable; falling back to static catalog.",
    );
  });

  test("returns requested off without warning when model is not found", () => {
    const result = resolveThinkingLevel("off", "nonexistent", "model-1");
    expect(result.level).toBe("off");
    expect(result.warning).toBeUndefined();
  });

  test("returns requested off without warning when live registry misses with no diagnostic", () => {
    const result = resolveThinkingLevel("off", "nonexistent", "model-1", {
      registry: registryFixture([]),
    });
    expect(result.level).toBe("off");
    expect(result.warning).toBeUndefined();
    expect(result.diagnostic).toBeUndefined();
  });

  test("estimates off with warning for unknown model when requested is not off", () => {
    const result = resolveThinkingLevel("low", "nonexistent", "model-1");
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("low", "off", "nonexistent", "model-1"),
    );
  });

  test("treats missing provider as no model", () => {
    const result = resolveThinkingLevel("medium", undefined, "model-1");
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("medium", "off", undefined, "model-1"),
    );
  });

  test("treats missing model ID as no model", () => {
    const result = resolveThinkingLevel("medium", "openai", undefined);
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("medium", "off", "openai", undefined),
    );
  });

  test("requested off with missing identifiers stays warning-free", () => {
    const result = resolveThinkingLevel("off", undefined, undefined);
    expect(result.level).toBe("off");
    expect(result.warning).toBeUndefined();
  });

  test("returns off with warning when model reasoning is disabled", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4");
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("high", "off", "openai", "gpt-4"),
    );
  });

  test("preserves reasoning-disabled warning even when requested is off", () => {
    const result = resolveThinkingLevel("off", "openai", "gpt-4");
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("off", "off", "openai", "gpt-4"),
    );
  });

  test("returns requested level for model with matching supported level", () => {
    const live = modelFixture({
      provider: "custom",
      id: "tiered",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "medium",
        high: "high",
      },
    });
    const result = resolveThinkingLevel("high", "custom", "tiered", {
      registry: registryFixture([live]),
    });
    expect(result.level).toBe("high");
    expect(result.warning).toBeUndefined();
  });

  test("returns requested level when model has no explicit supported-level list", () => {
    const live = modelFixture({
      provider: "custom",
      id: "reasoner",
      reasoning: true,
    });
    const result = resolveThinkingLevel("medium", "custom", "reasoner", {
      registry: registryFixture([live]),
    });
    expect(result.level).toBe("medium");
    expect(result.warning).toBeUndefined();
  });

  test("clamps unsupported level with warning when model has supported list", () => {
    const result = resolveThinkingLevel("off", "openai", "gpt-5");
    expect(result.level).toBe("minimal");
    expect(result.warning).toBe(
      unsupportedWarning("off", "minimal", "openai", "gpt-5"),
    );
  });

  test("returns clamped level with warning when requested exceeds supported maximum", () => {
    const result = resolveThinkingLevel("max", "openai", "gpt-5.2-chat-latest");
    expect(result.level).toBe("xhigh");
    expect(result.warning).toBe(
      unsupportedWarning("max", "xhigh", "openai", "gpt-5.2-chat-latest"),
    );
  });

  test("diagnostic is separate from clamp warning", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4");
    expect(result.diagnostic).toBe(
      "Live model registry unavailable; falling back to static catalog.",
    );
    expect(result.warning).not.toContain("registry");
    expect(result.warning).not.toContain("catalog");
  });

  test("uses unknown placeholders in warning when identifiers are missing", () => {
    const result = resolveThinkingLevel("high", undefined, undefined);
    expect(result.warning).toBe(unsupportedWarning("high", "off"));
    expect(result.warning).toContain("provider: unknown");
    expect(result.warning).toContain("model: unknown");
  });

  test("handles every requested level for an unknown model", () => {
    const levels: ThinkingLevel[] = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];
    for (const level of levels) {
      const result = resolveThinkingLevel(level, "openai", "gpt-4");
      expect(result.level).toBeDefined();
      expect(typeof result.level).toBe("string");
    }
  });
});
