import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "../src/agent/agents.js";
import type { ModelRegistry } from "../src/child/model-resolution.js";
import { buildPiArgs } from "../src/child/pi-args.js";
import { runSingleAgent } from "../src/child/process.js";
import {
  resolvePackageExtensionPath,
  resolveSamplingExtensionPath,
} from "../src/child/process-utils.js";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import type { SingleResult } from "../src/shared/types.js";
import {
  CAPTURE_ARGS_PI_SCRIPT,
  flagValues,
  hangAgent,
  makeSubagentDetails,
  registryFixture,
  setupHooks,
  setupTest,
} from "./helpers.js";

setupHooks();

type CapturableParentModel = {
  provider?: string | undefined;
  id?: string | undefined;
};

function buildArgsWithExtensions(
  agentOverrides: Partial<AgentConfig>,
  resolvedExtensionPaths?: string[],
): string[] {
  return buildPiArgs({
    agent: { ...hangAgent, ...agentOverrides },
    task: "task",
    effectiveModel: { id: "test-model" },
    thinking: "off",
    resolvedSkills: { args: [] },
    tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
    resolvedExtensionPaths,
  });
}

function buildContractArgs(
  task: string,
  tmpPrompt: { filePath: string } | null,
  agentOverrides: Partial<AgentConfig> = {},
  resolvedExtensionPaths?: string[],
  samplingEnv?: string,
): string[] {
  return buildPiArgs({
    agent: { ...hangAgent, ...agentOverrides },
    task,
    effectiveModel: { id: "test-model" },
    thinking: "off",
    resolvedSkills: { args: [] },
    tmpPrompt,
    resolvedExtensionPaths,
    samplingEnv,
  });
}

async function captureRunSingleAgentArgs(
  agent: AgentConfig,
  parentModel: CapturableParentModel | undefined,
  options: { registry?: ModelRegistry } = { registry: registryFixture([]) },
): Promise<string[]> {
  return (await runCapturedModelAgent(agent, parentModel, "off", options)).args;
}

function extensionFlags(args: string[]): { path: string; index: number }[] {
  return args.flatMap((arg, i) =>
    arg === "--extension" ? [{ path: args[i + 1] ?? "", index: i }] : [],
  );
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

describe("buildPiArgs contract delivery invariants", () => {
  test("tmpPrompt present places contract as last append after body prompt", () => {
    const args = buildContractArgs("task", {
      filePath: "/tmp/fake-prompt.md",
    });
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toEqual(["/tmp/fake-prompt.md", SUBAGENT_RESULT_CONTRACT]);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("tmpPrompt absent places contract as the only append value", () => {
    const args = buildContractArgs("task", null);
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toEqual([SUBAGENT_RESULT_CONTRACT]);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("empty task fallback with body prompt receives contract last", () => {
    const args = buildContractArgs("", {
      filePath: "/tmp/fake-prompt.md",
    });
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toEqual(["/tmp/fake-prompt.md", SUBAGENT_RESULT_CONTRACT]);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe(
      "Run according to your system prompt. If no explicit task was provided, use the default context described there.",
    );
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("empty task fallback without body prompt receives contract as only append", () => {
    const args = buildContractArgs("", null);
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toEqual([SUBAGENT_RESULT_CONTRACT]);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe(
      "Run according to your system prompt. If no explicit task was provided, use the default context described there.",
    );
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("contract remains last append when extensions are disabled", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { extensions: [] },
    );
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("contract remains last append with named extensions and preserves complete extension", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { extensions: ["ext-a"] },
      ["/ext/a.js"],
    );
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    const exts = flagValues(args, "--extension");
    expect(exts.some((p) => p.includes("complete-extension"))).toBe(true);
  });

  test("contract remains last append with custom tools containing complete and deduplicates complete", () => {
    const args = buildContractArgs("task", null, {
      tools: ["complete", "bash"],
    });
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    const tools = flagValues(args, "--tools")[0]?.split(",") ?? [];
    expect(tools.filter((t) => t === "complete")).toHaveLength(1);
    expect(tools).toContain("bash");
  });

  test("contract remains last append with context disabled and preserves unrelated flags", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { context: false },
    );
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args).toContain("--no-context-files");
    expect(args).toContain("--approve");
    expect(args).toContain("--no-themes");
    expect(args).toContain("--no-prompt-templates");
    expect(args.at(-1)).toBe("Task: task");
  });

  test("contract remains last append with skills disabled", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { skills: false },
    );
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args).toContain("--no-skills");
    expect(args.at(-1)).toBe("Task: task");
  });

  test("contract appears exactly once among appended system prompts", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { extensions: ["ext-a"] },
      ["/ext/a.js"],
    );
    const appends = flagValues(args, "--append-system-prompt");
    const contractCount = appends.filter(
      (a) => a === SUBAGENT_RESULT_CONTRACT,
    ).length;
    expect(contractCount).toBe(1);
  });

  test("sampling extension is loaded before the contract append", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { temperature: 0.7, topP: 0.9 },
      undefined,
      JSON.stringify({ temperature: 0.7, topP: 0.9 }),
    );
    const contractIdx = args.indexOf(SUBAGENT_RESULT_CONTRACT);
    const exts = flagValues(args, "--extension");
    expect(exts.some((p) => p.includes("sampling-extension"))).toBe(true);
    const samplingIdx = args.indexOf(
      exts.find((p) => p.includes("sampling-extension")) ?? "",
    );
    expect(contractIdx).toBeGreaterThan(samplingIdx);
    expect(args.at(-1)).toBe("Task: task");
  });

  test("task prompt arg never contains contract text across configurations", () => {
    const configs: {
      name: string;
      task: string;
      tmpPrompt: { filePath: string } | null;
      overrides: Partial<AgentConfig>;
      resolvedPaths?: string[];
    }[] = [
      {
        name: "task with body",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: {},
      },
      {
        name: "task without body",
        task: "task",
        tmpPrompt: null,
        overrides: {},
      },
      {
        name: "empty task with body",
        task: "",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: {},
      },
      {
        name: "empty task without body",
        task: "",
        tmpPrompt: null,
        overrides: {},
      },
      {
        name: "extensions disabled",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: { extensions: [] },
      },
      {
        name: "named extensions",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: { extensions: ["ext-a"] },
        resolvedPaths: ["/ext/a.js"],
      },
      {
        name: "custom tools with complete",
        task: "task",
        tmpPrompt: null,
        overrides: { tools: ["complete", "bash"] },
      },
      {
        name: "context disabled",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: { context: false },
      },
      {
        name: "skills disabled",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: { skills: false },
      },
    ];
    for (const config of configs) {
      const args = buildContractArgs(
        config.task,
        config.tmpPrompt,
        config.overrides,
        config.resolvedPaths,
      );
      const taskArg = args.at(-1) ?? "";
      expect(taskArg, config.name).not.toContain("Subagent Result Contract");
      expect(taskArg, config.name).not.toContain("MANDATORY");
    }
  });

  test("replacePrompt true routes body via --system-prompt and keeps contract last", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { replacePrompt: true },
    );
    expect(flagValues(args, "--system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
    ]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
    expect(args.indexOf("--system-prompt")).toBeGreaterThan(-1);
    expect(args.indexOf(SUBAGENT_RESULT_CONTRACT)).toBeGreaterThan(
      args.indexOf("--system-prompt"),
    );
    expect(args.at(-1)).toBe("Task: task");
  });

  test("replacePrompt false keeps --append-system-prompt body delivery", () => {
    const agent = {
      ...hangAgent,
      replacePrompt: false,
    } as unknown as AgentConfig;
    const args = buildPiArgs({
      agent,
      task: "task",
      effectiveModel: { id: "test-model" },
      thinking: "off",
      resolvedSkills: { args: [] },
      tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
    });
    expect(flagValues(args, "--system-prompt")).toEqual([]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
      SUBAGENT_RESULT_CONTRACT,
    ]);
  });

  test("replacePrompt omitted keeps --append-system-prompt body delivery", () => {
    const args = buildContractArgs("task", { filePath: "/tmp/fake-prompt.md" });
    expect(flagValues(args, "--system-prompt")).toEqual([]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
      SUBAGENT_RESULT_CONTRACT,
    ]);
  });

  test("replacePrompt true with empty task uses --system-prompt and default task prompt last", () => {
    const args = buildContractArgs(
      "",
      { filePath: "/tmp/fake-prompt.md" },
      { replacePrompt: true },
    );
    expect(flagValues(args, "--system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
    ]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
    expect(args.at(-1)).toBe(
      "Run according to your system prompt. If no explicit task was provided, use the default context described there.",
    );
  });

  test("replacePrompt true preserves unrelated flags", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { replacePrompt: true, context: false, tools: ["bash"] },
    );
    expect(flagValues(args, "--system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
    ]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
    expect(args).toContain("--no-context-files");
    expect(flagValues(args, "--tools")[0]?.split(",")).toContain("bash");
    expect(args.at(-1)).toBe("Task: task");
  });

  test("replacePrompt true with no body omits --system-prompt and appends contract only", () => {
    const args = buildContractArgs("task", null, { replacePrompt: true });
    expect(flagValues(args, "--system-prompt")).toEqual([]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
  });
});

test("SUBAGENT_RESULT_CONTRACT contains complete tool instructions", () => {
  expect(SUBAGENT_RESULT_CONTRACT).toContain(
    "Write the complete task result as assistant text",
  );
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(
    /Call `complete` as the final action/,
  );
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(/one-sentence progress/i);
  expect(SUBAGENT_RESULT_CONTRACT).not.toMatch(/Outcome: <short/);
});

test("SUBAGENT_RESULT_CONTRACT narrows code-block constraint to entire-result wrapper", () => {
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(
    /NEVER.*wrap the entire result in a code block/i,
  );
  expect(SUBAGENT_RESULT_CONTRACT).not.toMatch(
    /NEVER.*wrap result in code blocks/i,
  );
});

test("buildPiArgs appends --no-context-files when agent.context is false", async () => {
  const agent: AgentConfig = {
    ...hangAgent,
    context: false,
  };
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--no-context-files");
  expect(args.filter((a) => a === "--no-context-files")).toHaveLength(1);
});

test.each([
  {
    name: "buildPiArgs omits --no-context-files when agent.context is undefined",
    flag: "--no-context-files",
  },
  {
    name: "buildPiArgs omits --no-skills when agent.skills is undefined",
    flag: "--no-skills",
  },
])("$name", async (row) => {
  const args = await captureRunSingleAgentArgs(hangAgent, undefined);
  expect(args).not.toContain(row.flag);
});

test("buildPiArgs --no-context-files coexists with approval, model, provider, thinking, tools, prompt, and complete extension", async () => {
  const agent: AgentConfig = {
    ...hangAgent,
    context: false,
    tools: ["bash", "read"],
    thinking: "high",
    model: "gpt-4",
    provider: "openai",
  };
  const { args, result } = await runCapturedModelAgent(
    agent,
    { provider: "anthropic", id: "claude-3-7-sonnet-20250219" },
    "off",
    { registry: registryFixture([]) },
  );
  expect(args).toContain("--no-context-files");
  expect(args).toContain("--approve");
  expect(flagValues(args, "--provider")).toEqual(["openai"]);
  expect(flagValues(args, "--model")).toEqual(["gpt-4"]);
  expect(args).toContain("--thinking");
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(args).toContain("--tools");
  expect(args).toContain("--append-system-prompt");
  expect(args.some((a) => a.startsWith("Task: "))).toBe(true);
  expect(result.model).toBe("openai ･ gpt-4 ･ off");
  expect(result.thinkingWarning).toContain('using "off" instead');
});

test("buildPiArgs --no-context-files coexists with sampling extension args", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const agent: AgentConfig = {
    ...hangAgent,
    context: false,
    temperature: 0.7,
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  const args = fs
    .readFileSync(path.join(cwd, "args.txt"), "utf8")
    .trimEnd()
    .split("\n");
  expect(args).toContain("--no-context-files");
  expect(flagValues(args, "--extension")).toContain(
    resolveSamplingExtensionPath(),
  );
});

test("buildPiArgs omits --no-context-files for depth-limit and unknown-agent failures", async () => {
  process.env.PI_SUBAGENT_DEPTH = "5";
  const { result: depthResult } = await runSingleAgent(
    "/tmp",
    [{ ...hangAgent, context: false }],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(depthResult.exitCode).toBe(1);
  expect(depthResult.stderr).toContain("depth 5/5");
  const { result: unknownResult } = await runSingleAgent(
    "/tmp",
    [{ ...hangAgent, context: false }],
    "missing",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(unknownResult.exitCode).toBe(1);
  expect(unknownResult.stderr).toContain("Unknown agent");
});

test.each([
  { name: "buildPiArgs always includes --no-themes", flag: "--no-themes" },
  {
    name: "buildPiArgs always includes --no-prompt-templates",
    flag: "--no-prompt-templates",
  },
])("$name", async (row) => {
  const args = await captureRunSingleAgentArgs(hangAgent, undefined);
  expect(args).toContain(row.flag);
});

test("buildPiArgs --no-themes and --no-prompt-templates coexist with --no-context-files and model flags", async () => {
  const agent: AgentConfig = {
    ...hangAgent,
    context: false,
    model: "gpt-4",
    provider: "openai",
  };
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--no-themes");
  expect(args).toContain("--no-prompt-templates");
  expect(args).toContain("--no-context-files");
  expect(flagValues(args, "--model")).toEqual(["gpt-4"]);
});

test("buildPiArgs appends --no-skills with no paths when agent.skills is false", async () => {
  const agent: AgentConfig = { ...hangAgent, skills: false };
  const args = await captureRunSingleAgentArgs(agent, undefined);
  const idx = args.indexOf("--no-skills");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).not.toBe(undefined);
  const nextFlag = args[idx + 1];
  expect(nextFlag?.startsWith("--") || nextFlag?.startsWith("Task:")).toBe(
    true,
  );
});

test("buildPiArgs appends --no-skills with no paths when agent.skills is empty array", async () => {
  const agent: AgentConfig = { ...hangAgent, skills: [] };
  const args = await captureRunSingleAgentArgs(agent, undefined);
  const idx = args.indexOf("--no-skills");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).not.toBe(undefined);
  const nextFlag = args[idx + 1];
  expect(nextFlag?.startsWith("--") || nextFlag?.startsWith("Task:")).toBe(
    true,
  );
});

test("buildPiArgs omitted extensions emits no --no-extensions and no index extension", () => {
  const agent: AgentConfig = { ...hangAgent };
  expect(Object.hasOwn(agent, "extensions")).toBe(false);
  const args = buildArgsWithExtensions(agent);
  expect(args).not.toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  expect(args).not.toContain(pkgPath);
  expect(flagValues(args, "--extension")).not.toContain(pkgPath);
});

test("buildPiArgs extensions false emits --no-extensions and package index", () => {
  const args = buildArgsWithExtensions({ extensions: [] });
  expect(args).toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  expect(flagValues(args, "--extension")).toContain(pkgPath);
});

test("buildPiArgs extensions empty parsed string emits --no-extensions and package index", () => {
  const args = buildArgsWithExtensions({ extensions: [] });
  const argFlags = extensionFlags(args);
  const pkgPath = resolvePackageExtensionPath();
  expect(args).toContain("--no-extensions");
  expect(argFlags.map((f) => f.path)).toContain(pkgPath);
});

test("buildPiArgs named extensions emits --no-extensions, index, and named paths", () => {
  const fakePaths = ["/ext/a.js", "/ext/b.js"];
  const args = buildArgsWithExtensions(
    { extensions: ["ext-a", "ext-b"] },
    fakePaths,
  );
  expect(args).toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  const exts = flagValues(args, "--extension");
  expect(exts).toContain(pkgPath);
  expect(exts).toContain("/ext/a.js");
  expect(exts).toContain("/ext/b.js");
});

test("buildPiArgs named extensions with resolved path equal to index de-duplicates index path", () => {
  const pkgPath = resolvePackageExtensionPath();
  const fakePaths = ["/ext/unique.js", pkgPath];
  const args = buildArgsWithExtensions(
    { extensions: ["unique", "self"] },
    fakePaths,
  );
  expect(args).toContain("--no-extensions");
  const exts = flagValues(args, "--extension");
  const pkgCount = exts.filter((p) => p === pkgPath).length;
  expect(pkgCount).toBe(1);
  expect(exts).toContain("/ext/unique.js");
});

test("buildPiArgs index extension appears exactly once when no named paths provided", () => {
  const args = buildArgsWithExtensions({ extensions: [] });
  const pkgPath = resolvePackageExtensionPath();
  const exts = flagValues(args, "--extension");
  const pkgCount = exts.filter((p) => p === pkgPath).length;
  expect(pkgCount).toBe(1);
});

test("buildPiArgs complete extension present when extensions disabled", () => {
  const args = buildArgsWithExtensions({ extensions: [] });
  const exts = extensionFlags(args);
  const completeIdx = exts.findIndex((f) =>
    f.path.includes("complete-extension"),
  );
  expect(completeIdx).toBeGreaterThanOrEqual(0);
});

test("buildPiArgs absent extension field regression: no --no-extensions and no index injection", () => {
  const args = buildArgsWithExtensions({});
  expect(args).not.toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  expect(flagValues(args, "--extension")).not.toContain(pkgPath);
  expect(args).toContain("--approve");
  expect(args).toContain("--no-themes");
});

test("buildPiArgs named extensions preserves complete extension after named paths", () => {
  const args = buildArgsWithExtensions({ extensions: ["ext-a"] }, [
    "/ext/a.js",
  ]);
  const exts = extensionFlags(args);
  const paths = exts.map((f) => f.path);
  const pkgIdx = paths.indexOf(resolvePackageExtensionPath());
  const namedIdx = paths.indexOf("/ext/a.js");
  const completeIdx = paths.findIndex((p) => p.includes("complete-extension"));
  expect(pkgIdx).toBeGreaterThanOrEqual(0);
  expect(namedIdx).toBeGreaterThan(pkgIdx);
  expect(completeIdx).toBeGreaterThan(namedIdx);
});

test("buildPiArgs named extensions preserves first-seen order from resolved paths", () => {
  const fakePaths = ["/ext/c.js", "/ext/a.js", "/ext/b.js"];
  const args = buildArgsWithExtensions(
    { extensions: ["c", "a", "b"] },
    fakePaths,
  );
  const exts = extensionFlags(args);
  const pkgPath = resolvePackageExtensionPath();
  const namedFlags = exts.filter(
    (f) => f.path !== pkgPath && !f.path.includes("complete-extension"),
  );
  expect(namedFlags.map((f) => f.path)).toEqual([
    "/ext/c.js",
    "/ext/a.js",
    "/ext/b.js",
  ]);
});
