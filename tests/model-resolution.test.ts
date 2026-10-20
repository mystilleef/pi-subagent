import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentConfig, ThinkingLevel } from "../src/agent/agents.js";
import type { ModelRegistry } from "../src/child/model-resolution.js";
import {
  buildModelDisplay,
  resolveEffectiveChildModelSettings,
  resolveThinkingLevel,
} from "../src/child/model-resolution.js";
import { runSingleAgent } from "../src/child/process.js";
import type { SingleResult } from "../src/shared/types.js";
import {
  CAPTURE_ARGS_PI_SCRIPT,
  flagValues,
  hangAgent,
  makeModelAgent,
  makeSubagentDetails,
  modelFixture,
  registryFixture,
  setupHooks,
  setupTest,
  unconfirmedWarning,
  unsupportedWarning,
} from "./helpers.js";

setupHooks();

type CapturableParentModel = {
  provider?: string | undefined;
  id?: string | undefined;
};

async function captureRunSingleAgentArgs(
  agent: AgentConfig,
  parentModel: CapturableParentModel | undefined,
  options: { registry?: ModelRegistry } = { registry: registryFixture([]) },
): Promise<string[]> {
  return (await runCapturedModelAgent(agent, parentModel, "off", options)).args;
}

async function runCapturedModelAgent(
  agent: AgentConfig,
  parentModel: CapturableParentModel | undefined,
  parentThinking: AgentConfig["thinking"] = "off",
  options?: { registry?: ModelRegistry },
): Promise<{ args: string[]; result: SingleResult }> {
  const { cwd } = await setupTest({
    piScript: CAPTURE_ARGS_PI_SCRIPT,
  });
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    parentModel,
    parentThinking ?? "off",
    false,
    options,
  );
  expect(result.exitCode).toBe(0);
  return {
    args: fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n"),
    result,
  };
}

describe("unconfirmed thinking display propagation", () => {
  test("unknown model preserves requested level and emits exact unconfirmed warning", async () => {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({
        provider: "unknown",
        model: "unknown",
        thinking: "high",
      }),
      undefined,
      "off",
      { registry: registryFixture([]) },
    );
    expect(flagValues(args, "--thinking")).toEqual(["high"]);
    expect(result.model).toBe("unknown ･ unknown ･ high");
    expect(result.thinkingWarning).toBe(
      unconfirmedWarning("high", "unknown", "unknown"),
    );
  });

  test("missing identifiers preserve requested level with unknown placeholders", async () => {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({ thinking: "medium" }),
      undefined,
      "off",
    );
    expect(flagValues(args, "--thinking")).toEqual(["medium"]);
    expect(result.model).toBe("medium");
    expect(result.thinkingWarning).toBe(
      unconfirmedWarning("medium", undefined, undefined),
    );
  });

  test("missing identifiers with off thinking stay warning-free", async () => {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({ thinking: "off" }),
      undefined,
      "off",
    );
    expect(flagValues(args, "--thinking")).toEqual(["off"]);
    expect(result.model).toBe("off");
    expect(result.thinkingWarning).toBeUndefined();
  });

  test("confirmed live model shows requested level without warning", async () => {
    const live = modelFixture({
      provider: "custom",
      id: "reasoner",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "medium",
        high: "high",
      },
    });
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({
        provider: "custom",
        model: "reasoner",
        thinking: "medium",
      }),
      undefined,
      "off",
      { registry: registryFixture([live]) },
    );
    expect(flagValues(args, "--thinking")).toEqual(["medium"]);
    expect(result.model).toBe("custom ･ reasoner ･ medium");
    expect(result.thinkingWarning).toBeUndefined();
  });

  test("reasoning-disabled off request retains unsupported warning", async () => {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({ provider: "openai", model: "gpt-4", thinking: "off" }),
      undefined,
      "off",
      { registry: registryFixture([]) },
    );
    expect(flagValues(args, "--thinking")).toEqual(["off"]);
    expect(result.model).toBe("openai ･ gpt-4 ･ off");
    expect(result.thinkingWarning).toContain('using "off" instead');
  });
});

test("runSingleAgent resolves child model flags independently from agent and parent settings", async () => {
  const cases: {
    name: string;
    agent: AgentConfig;
    parentModel: CapturableParentModel | undefined;
    providerFlags: string[];
    modelFlags: string[];
  }[] = [
    {
      name: "inherits both parent fields without overrides",
      agent: makeModelAgent({}),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: ["parent-provider"],
      modelFlags: ["parent-model"],
    },
    {
      name: "omits provider-only flag when agent overrides provider without model",
      agent: makeModelAgent({ provider: "agent-provider" }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: [],
      modelFlags: [],
    },
    {
      name: "inherits provider and overrides model",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: ["parent-provider"],
      modelFlags: ["agent-model"],
    },
    {
      name: "overrides both fields",
      agent: makeModelAgent({
        provider: "agent-provider",
        model: "agent-model",
      }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: ["agent-provider"],
      modelFlags: ["agent-model"],
    },
    {
      name: "omits provider flag when parent model id is absent",
      agent: makeModelAgent({}),
      parentModel: { provider: "parent-provider" },
      providerFlags: [],
      modelFlags: [],
    },
    {
      name: "emits model only when parent provider remains absent",
      agent: makeModelAgent({}),
      parentModel: { id: "parent-model" },
      providerFlags: [],
      modelFlags: ["parent-model"],
    },
    {
      name: "omits provider flag without model when parent model absent",
      agent: makeModelAgent({ provider: "agent-provider" }),
      parentModel: undefined,
      providerFlags: [],
      modelFlags: [],
    },
    {
      name: "emits model only without parent provider",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: undefined,
      providerFlags: [],
      modelFlags: ["agent-model"],
    },
    {
      name: "omits both flags without any effective settings",
      agent: makeModelAgent({ provider: undefined, model: undefined }),
      parentModel: undefined,
      providerFlags: [],
      modelFlags: [],
    },
    {
      name: "inherits parent when blank-normalized agent fields are absent",
      agent: makeModelAgent({ provider: undefined, model: undefined }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: ["parent-provider"],
      modelFlags: ["parent-model"],
    },
    {
      name: "passes invalid runtime strings unchanged",
      agent: makeModelAgent({ provider: "not/a/provider", model: "???" }),
      parentModel: undefined,
      providerFlags: ["not/a/provider"],
      modelFlags: ["???"],
    },
  ];
  for (const testCase of cases) {
    const args = await captureRunSingleAgentArgs(
      testCase.agent,
      testCase.parentModel,
    );
    expect(flagValues(args, "--provider"), testCase.name).toEqual(
      testCase.providerFlags,
    );
    expect(flagValues(args, "--model"), testCase.name).toEqual(
      testCase.modelFlags,
    );
  }
});

test("runSingleAgent applies effective model settings to thinking resolution", async () => {
  const { result } = await runCapturedModelAgent(
    makeModelAgent({ provider: "openai", model: "gpt-4", thinking: "high" }),
    { provider: "anthropic", id: "claude-3-7-sonnet-20250219" },
    "low",
    { registry: registryFixture([]) },
  );
  expect(result.model).toBe("openai ･ gpt-4 ･ off");
  expect(result.thinkingWarning).toContain("provider: openai");
  expect(result.thinkingWarning).toContain("model: gpt-4");
  expect(result.thinkingWarning).toContain('using "off" instead');
});

test("runSingleAgent treats provider-only agent override as partial model", async () => {
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({ provider: "agent-provider", thinking: "high" }),
    { provider: "openai", id: "gpt-4" },
    "low",
  );
  expect(flagValues(args, "--provider")).toEqual([]);
  expect(flagValues(args, "--model")).toEqual([]);
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("agent-provider ･ high");
  expect(result.thinkingWarning).toContain("provider: agent-provider");
  expect(result.thinkingWarning).toContain("model: unknown");
  expect(result.thinkingWarning).toContain("requesting as-is");
});

test("runSingleAgent preserves requested thinking for partial or absent effective models", async () => {
  const cases: {
    name: string;
    agent: AgentConfig;
    parentModel: CapturableParentModel | undefined;
    expectedModel: string;
  }[] = [
    {
      name: "model only",
      agent: makeModelAgent({ thinking: undefined }),
      parentModel: { id: "parent-model" },
      expectedModel: "parent-model ･ high",
    },
    {
      name: "provider only",
      agent: makeModelAgent({
        provider: "agent-provider",
        thinking: undefined,
      }),
      parentModel: undefined,
      expectedModel: "agent-provider ･ high",
    },
    {
      name: "absent model",
      agent: makeModelAgent({ thinking: undefined }),
      parentModel: undefined,
      expectedModel: "high",
    },
  ];
  for (const testCase of cases) {
    const { result } = await runCapturedModelAgent(
      testCase.agent,
      testCase.parentModel,
      "high",
    );
    expect(result.thinkingWarning, testCase.name).toBeDefined();
    expect(result.thinkingWarning, testCase.name).toContain("requesting as-is");
    expect(result.model, testCase.name).toBe(testCase.expectedModel);
  }
});

test("runSingleAgent prefers live registry match over static catalog", async () => {
  const live = modelFixture({
    provider: "openai",
    id: "gpt-4",
    reasoning: true,
  });
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({
      provider: "openai",
      model: "gpt-4",
      thinking: "high",
    }),
    undefined,
    "off",
    { registry: registryFixture([live]) },
  );
  expect(flagValues(args, "--provider")).toEqual(["openai"]);
  expect(flagValues(args, "--model")).toEqual(["gpt-4"]);
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("openai ･ gpt-4 ･ high");
  expect(result.thinkingWarning).toBeUndefined();
});

test("runSingleAgent falls back to static catalog when live registry misses", async () => {
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({
      provider: "openai",
      model: "gpt-4",
      thinking: "high",
    }),
    undefined,
    "off",
    { registry: registryFixture([]) },
  );
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("openai ･ gpt-4 ･ off");
  expect(result.thinkingWarning).toContain('using "off" instead');
});

test("runSingleAgent inherits parent thinking request when agent omits it", async () => {
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
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({ provider: "openai", model: "gpt-4", thinking: undefined }),
    undefined,
    "high",
    { registry: registryFixture([live]) },
  );
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("openai ･ gpt-4 ･ high");
  expect(result.thinkingWarning).toBeUndefined();
});

test("runSingleAgent retains parent thinking request through catalog clamp", async () => {
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({ provider: "openai", model: "gpt-4", thinking: undefined }),
    undefined,
    "high",
    { registry: registryFixture([]) },
  );
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("openai ･ gpt-4 ･ off");
  expect(result.thinkingWarning).toContain('using "off" instead');
});

test("runSingleAgent emits unavailable registry diagnostic and continues", async () => {
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({ provider: "openai", model: "gpt-4", thinking: "high" }),
      undefined,
      "off",
    );
    expect(flagValues(args, "--thinking")).toEqual(["high"]);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("openai ･ gpt-4 ･ off");
    expect(warnSpy).toHaveBeenCalledWith(
      "Live model registry unavailable; falling back to static catalog.",
    );
  } finally {
    warnSpy.mockRestore();
  }
});

test("runSingleAgent formats result model from effective non-empty parts", async () => {
  const cases: {
    name: string;
    agent: AgentConfig;
    parentModel: CapturableParentModel | undefined;
    expectedModel: string;
  }[] = [
    {
      name: "inherits full parent model",
      agent: makeModelAgent({}),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      expectedModel: "parent-provider ･ parent-model ･ off",
    },
    {
      name: "overrides model without leading slash",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: undefined,
      expectedModel: "agent-model ･ off",
    },
    {
      name: "omits empty provider with model override",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: { provider: undefined },
      expectedModel: "agent-model ･ off",
    },
    {
      name: "preserves effective provider and model suffix",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      expectedModel: "parent-provider ･ agent-model ･ off",
    },
  ];
  for (const testCase of cases) {
    const { result } = await runCapturedModelAgent(
      testCase.agent,
      testCase.parentModel,
      "off",
      { registry: registryFixture([]) },
    );
    expect(result.model, testCase.name).toBe(testCase.expectedModel);
  }
});

test("runSingleAgent reports effective model display on skill resolution failure", async () => {
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
    cwd,
    [
      makeModelAgent({
        name: "bad-skill-model",
        model: "agent-model",
        skills: ["missing-skill"],
      }),
    ],
    "bad-skill-model",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    { provider: "parent-provider", id: "parent-model" },
    "off",
    false,
    { registry: registryFixture([]) },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown skill: "missing-skill"');
  expect(result.model).toBe("parent-provider ･ agent-model ･ off");
});

test("runSingleAgent reports extension resolution error with model display", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    ...hangAgent,
    model: "agent-model",
    extensions: ["nonexistent-ext"],
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    { provider: "parent-provider", id: "parent-model" },
    "off",
    false,
    { registry: registryFixture([]) },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown extension: "nonexistent-ext"');
  expect(result.model).toBe("parent-provider ･ agent-model ･ off");
});

describe("resolveEffectiveChildModelSettings", () => {
  test("uses agent provider and model when both provided", () => {
    const agent = { provider: "openai", model: "gpt-4" };
    const result = resolveEffectiveChildModelSettings(agent, undefined);
    expect(result).toEqual({ provider: "openai", id: "gpt-4" });
  });

  test.each([
    {
      name: "falls back to parent provider when agent provider is missing",
      agentModel: "gpt-4",
      parentProvider: "anthropic",
      parentId: "claude-sonnet",
      expectedProvider: "anthropic",
      expectedId: "gpt-4",
    },
    {
      name: "agent model overrides parent model when no agent provider",
      agentModel: "gemini-pro",
      parentProvider: "openai",
      parentId: "gpt-4",
      expectedProvider: "openai",
      expectedId: "gemini-pro",
    },
  ])("$name", (row) => {
    const agent = { model: row.agentModel };
    const parent = { provider: row.parentProvider, id: row.parentId };
    const result = resolveEffectiveChildModelSettings(agent, parent);
    expect(result).toEqual({
      provider: row.expectedProvider,
      id: row.expectedId,
    });
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

  test("handles agent with provider as undefined explicitly", () => {
    const agent = { provider: undefined, model: "gpt-4" };
    const parent = { provider: "anthropic", id: "claude-sonnet" };
    const result = resolveEffectiveChildModelSettings(agent, parent);
    expect(result).toEqual({ provider: "anthropic", id: "gpt-4" });
  });
});

describe("buildModelDisplay", () => {
  test.each([
    {
      name: "builds full display with provider, id, and thinking",
      thinking: "medium",
      expectedDisplay: "openai ･ gpt-4 ･ medium",
    },
    {
      name: "returns provider and id when thinking is falsy",
      thinking: "",
      expectedDisplay: "openai ･ gpt-4",
    },
  ])("$name", (row) => {
    const result = buildModelDisplay(
      { provider: "openai", id: "gpt-4" },
      row.thinking as ThinkingLevel,
    );
    expect(result).toBe(row.expectedDisplay);
  });

  test("returns provider and thinking when id is missing", () => {
    const result = buildModelDisplay({ provider: "openai" }, "high");
    expect(result).toBe("openai ･ high");
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

  test.each([
    {
      name: "clamps unsupported level and emits uniform warning",
      requestedLevel: "off",
      modelId: "gpt-5",
      expectedLevel: "minimal",
      warnedRequested: "off",
      warnedClamped: "minimal",
      warnedModelId: "gpt-5",
    },
    {
      name: "clamps max down to highest supported level",
      requestedLevel: "max",
      modelId: "gpt-5.2-chat-latest",
      expectedLevel: "xhigh",
      warnedRequested: "max",
      warnedClamped: "xhigh",
      warnedModelId: "gpt-5.2-chat-latest",
    },
    {
      name: "preserves reasoning-disabled warning even when requested is off",
      requestedLevel: "off",
      modelId: "gpt-4",
      expectedLevel: "off",
      warnedRequested: "off",
      warnedClamped: "off",
      warnedModelId: "gpt-4",
    },
  ])("$name", (row) => {
    const result = resolveThinkingLevel(
      row.requestedLevel,
      "openai",
      row.modelId,
    );
    expect(result.level).toBe(row.expectedLevel);
    expect(result.warning).toBe(
      unsupportedWarning(
        row.warnedRequested,
        row.warnedClamped,
        "openai",
        row.warnedModelId,
      ),
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

  test("treats missing provider as unconfirmed and preserves requested level", () => {
    const result = resolveThinkingLevel("medium", undefined, "model-1");
    expect(result.level).toBe("medium");
    expect(result.warning).toBe(
      unconfirmedWarning("medium", undefined, "model-1"),
    );
  });

  test("treats missing model ID as unconfirmed and preserves requested level", () => {
    const result = resolveThinkingLevel("medium", "openai", undefined);
    expect(result.level).toBe("medium");
    expect(result.warning).toBe(
      unconfirmedWarning("medium", "openai", undefined),
    );
  });

  test("requested off with missing identifiers stays warning-free", () => {
    const result = resolveThinkingLevel("off", undefined, undefined);
    expect(result.level).toBe("off");
    expect(result.warning).toBeUndefined();
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

  test("diagnostic is separate from clamp warning", () => {
    const result = resolveThinkingLevel("high", "openai", "gpt-4");
    expect(result.diagnostic).toBe(
      "Live model registry unavailable; falling back to static catalog.",
    );
    expect(result.warning).not.toContain("registry");
    expect(result.warning).not.toContain("catalog");
  });

  test("uses unknown placeholders in unconfirmed warning when identifiers are missing", () => {
    const result = resolveThinkingLevel("high", undefined, undefined);
    expect(result.warning).toBe(unconfirmedWarning("high"));
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
      const result = resolveThinkingLevel(level, "nonexistent", "model-1");
      expect(result.level).toBe(level);
      if (level === "off") {
        expect(result.warning).toBeUndefined();
      } else {
        expect(result.warning).toBe(
          unconfirmedWarning(level, "nonexistent", "model-1"),
        );
      }
    }
  });
});
