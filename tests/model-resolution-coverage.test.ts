import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../src/agent/agents.js";
import {
  buildModelDisplay,
  type ModelRegistry,
  resolveEffectiveChildModelSettings,
  resolveThinkingLevel,
} from "../src/child/model-resolution.js";
import {
  modelFixture,
  registryFixture,
  unconfirmedWarning,
  unsupportedWarning,
} from "./helpers.js";

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
    const result = buildModelDisplay({ provider: "openai" }, "high");
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
    const result = buildModelDisplay({}, "low");
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
      "off",
    );
    expect(result).toBe("openai ･ gpt-4 ･ off");
  });
});

describe("resolveThinkingLevel", () => {
  test("static catalog resolves when registry is absent", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4");
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("high", "off", "openai", "gpt-4"),
    );
    expect(result.diagnostic).toBe(
      "Live model registry unavailable; falling back to static catalog.",
    );
  });

  test("static catalog resolves after a live-registry miss", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4", {
      registry: registryFixture([]),
    });
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("high", "off", "openai", "gpt-4"),
    );
  });

  test("live registry match outranks static catalog", () => {
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
  });

  test("requested off stays warning-free when no model is found", () => {
    const result = resolveThinkingLevel("off", "nonexistent", "model-1");
    expect(result.level).toBe("off");
    expect(result.warning).toBeUndefined();
  });

  test("requested off stays warning-free when live registry misses and no diagnostic", () => {
    const result = resolveThinkingLevel("off", "nonexistent", "model-1", {
      registry: registryFixture([]),
    });
    expect(result.level).toBe("off");
    expect(result.warning).toBeUndefined();
    expect(result.diagnostic).toBeUndefined();
  });

  test("non-off unknown request preserves level with unconfirmed warning", () => {
    const result = resolveThinkingLevel("low", "nonexistent", "model-1");
    expect(result.level).toBe("low");
    expect(result.warning).toBe(
      unconfirmedWarning("low", "nonexistent", "model-1"),
    );
  });

  test("missing provider or model ID preserves requested level with unconfirmed warning", () => {
    const missingProvider = resolveThinkingLevel(
      "medium",
      undefined,
      "model-1",
    );
    expect(missingProvider.level).toBe("medium");
    expect(missingProvider.warning).toBe(
      unconfirmedWarning("medium", undefined, "model-1"),
    );

    const missingModelId = resolveThinkingLevel("medium", "openai", undefined);
    expect(missingModelId.level).toBe("medium");
    expect(missingModelId.warning).toBe(
      unconfirmedWarning("medium", "openai", undefined),
    );
  });

  test("reasoning-disabled model estimates off with warning", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4");
    expect(result.level).toBe("off");
    expect(result.warning).toBe(
      unsupportedWarning("high", "off", "openai", "gpt-4"),
    );
  });

  test("model without explicit supported-level list retains request", () => {
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

  test("clamps unsupported level and emits uniform warning", () => {
    const result = resolveThinkingLevel("off", "openai", "gpt-5");
    expect(result.level).toBe("minimal");
    expect(result.warning).toBe(
      unsupportedWarning("off", "minimal", "openai", "gpt-5"),
    );
  });

  test("clamps max down to highest supported level", () => {
    const result = resolveThinkingLevel("max", "openai", "gpt-5.2-chat-latest");
    expect(result.level).toBe("xhigh");
    expect(result.warning).toBe(
      unsupportedWarning("max", "xhigh", "openai", "gpt-5.2-chat-latest"),
    );
  });

  test("warning format is deterministic for clamp, unconfirmed, and reasoning-disabled paths", () => {
    const clamped = resolveThinkingLevel("off", "openai", "gpt-5");
    const unconfirmed = resolveThinkingLevel("high", "nonexistent", "model-1");
    const reasoningDisabled = resolveThinkingLevel("high", "openai", "gpt-4");
    expect(clamped.warning).toBe(
      unsupportedWarning("off", "minimal", "openai", "gpt-5"),
    );
    expect(unconfirmed.warning).toBe(
      unconfirmedWarning("high", "nonexistent", "model-1"),
    );
    expect(reasoningDisabled.warning).toBe(
      unsupportedWarning("high", "off", "openai", "gpt-4"),
    );
  });

  test.each([
    ["off", undefined],
    ["minimal", unconfirmedWarning("minimal", undefined, undefined)],
    ["low", unconfirmedWarning("low", undefined, undefined)],
    ["medium", unconfirmedWarning("medium", undefined, undefined)],
    ["high", unconfirmedWarning("high", undefined, undefined)],
    ["xhigh", unconfirmedWarning("xhigh", undefined, undefined)],
    ["max", unconfirmedWarning("max", undefined, undefined)],
  ] as [ThinkingLevel, string | undefined][])(
    "missing identifiers resolve level %s with warning %p",
    (level, expectedWarning) => {
      const result = resolveThinkingLevel(level, undefined, undefined);
      expect(result.level).toBe(level);
      expect(result.warning).toBe(expectedWarning);
    },
  );

  test.each([
    ["off", undefined],
    ["minimal", unconfirmedWarning("minimal", "unknown", "unknown")],
    ["low", unconfirmedWarning("low", "unknown", "unknown")],
    ["medium", unconfirmedWarning("medium", "unknown", "unknown")],
    ["high", unconfirmedWarning("high", "unknown", "unknown")],
    ["xhigh", unconfirmedWarning("xhigh", "unknown", "unknown")],
    ["max", unconfirmedWarning("max", "unknown", "unknown")],
  ] as [ThinkingLevel, string | undefined][])(
    "unknown model resolves level %s with warning %p",
    (level, expectedWarning) => {
      const result = resolveThinkingLevel(level, "unknown", "unknown", {
        registry: registryFixture([]),
      });
      expect(result.level).toBe(level);
      expect(result.warning).toBe(expectedWarning);
    },
  );

  test("unconfirmed non-off keeps registry diagnostic separate from warning", () => {
    const result = resolveThinkingLevel("high", "nonexistent", "model-1");
    expect(result.level).toBe("high");
    expect(result.warning).toBe(
      unconfirmedWarning("high", "nonexistent", "model-1"),
    );
    expect(result.diagnostic).toBe(
      "Live model registry unavailable; falling back to static catalog.",
    );
    expect(result.warning).not.toContain("registry");
    expect(result.warning).not.toContain("catalog");
  });

  test("fixtures type-check as Model without casts", () => {
    const live: Model<Api> = modelFixture({
      provider: "typed",
      id: "fixture",
      reasoning: false,
      thinkingLevelMap: { off: null, high: "high" },
    });
    const registry: ModelRegistry = registryFixture([live]);
    const result = resolveThinkingLevel("high", "typed", "fixture", {
      registry,
    });
    expect(result.level).toBe("off");
  });
});
