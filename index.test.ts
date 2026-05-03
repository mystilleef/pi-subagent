import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type {
  AgentToolResult,
  AutocompleteProviderFactory,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import registerSubagentExtension, {
  type SubagentDetails,
  type SubagentParams,
} from "./index.js";

const ORIGINAL_ARGV_1 = process.argv[1] ?? "";
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupFakePi(): Promise<{
  agentDir: string;
  cwd: string;
  binDir: string;
}> {
  const root = await makeTempDir("pi-subagent-test-");
  const agentDir = path.join(root, "agent");
  const agentsDir = path.join(agentDir, "agents");
  const binDir = path.join(root, "bin");
  const cwd = path.join(root, "work");

  await Bun.$`mkdir -p ${agentsDir} ${binDir} ${cwd}`;
  await writeFile(
    path.join(agentsDir, "hang.md"),
    `---
name: hang
description: Test agent
thinking: off
---

Test agent prompt.
`,
  );

  const fakePi = path.join(binDir, "pi");
  await writeFile(
    fakePi,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
case "$*" in
  *agent-end-no-exit*) sleep 10 ;;
esac
exit 0
`,
  );
  await chmod(fakePi, 0o755);

  process.argv[1] = path.join(root, "not-pi");
  process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  return { agentDir, cwd, binDir };
}

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

type CapturedSubagentTool = ToolDefinition<
  typeof SubagentParams,
  SubagentDetails
> & {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<SubagentDetails>>;
};

function getSubagentTool(): CapturedSubagentTool {
  let registeredTool: RegisteredTool | undefined;
  const fakePi = {
    on() {},
    registerTool(tool: RegisteredTool) {
      registeredTool = tool;
    },
    getThinkingLevel() {
      return "off";
    },
  } as unknown as ExtensionAPI;

  registerSubagentExtension(fakePi);

  if (!registeredTool) throw new Error("subagent tool was not registered");
  return registeredTool as CapturedSubagentTool;
}

async function executeSubagent(task: string, signal?: AbortSignal) {
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool();
  return tool.execute(
    "test-tool-call",
    { agent: "hang", task },
    signal,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
}

function timeoutAfter(ms: number, onTimeout: () => void): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
  });
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  process.argv[1] = ORIGINAL_ARGV_1;
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("subagent resolves when fake pi exits normally", async () => {
  const result = await executeSubagent("normal");

  expect((result.content[0] as TextContent).text).toEqual("done");
});

test("subagent resolves when fake pi emits agent_end but stays alive", async () => {
  const controller = new AbortController();
  const run = executeSubagent("agent-end-no-exit", controller.signal);

  const result = await Promise.race([
    run,
    timeoutAfter(500, () => controller.abort()),
  ]);

  expect((result.content[0] as TextContent).text).toEqual("done");
});

test("subagent handles unknown agent", async () => {
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool();
  const promise = tool.execute(
    "test-tool-call",
    { agent: "non-existent", task: "whatever" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );

  await expect(promise).rejects.toThrow('Unknown agent: "non-existent"');
});

test("subagent respects agentScope", async () => {
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-agent.md"),
    `---
name: project-agent
description: Project agent
---
System prompt`,
  );

  const tool = getSubagentTool();

  // Default scope is "user", should NOT find project agent
  const promiseUser = tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await expect(promiseUser).rejects.toThrow();

  // Both scope should find project agent
  const resultBoth = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "both" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      ui: { confirm: async () => true },
    } as unknown as ExtensionContext,
  );
  expect((resultBoth.content[0] as TextContent).text).toBe("done");
});

test("subagent requires confirmation for project agents with UI", async () => {
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-agent.md"),
    `---
name: project-agent
description: Project agent
---
System prompt`,
  );

  const tool = getSubagentTool();
  let confirmed = false;
  const fakeUI = {
    confirm: async () => {
      confirmed = true;
      return false;
    },
  };

  const result = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "both" },
    undefined,
    undefined,
    { cwd, hasUI: true, ui: fakeUI } as unknown as ExtensionContext,
  );

  expect(confirmed).toBe(true);
  expect((result.content[0] as TextContent).text).toContain("Canceled");
});

test("subagent handles abort", async () => {
  const { binDir, cwd } = await setupFakePi();
  // Override pi to hang
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  );

  const tool = getSubagentTool();
  const controller = new AbortController();

  const promise = tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    controller.signal,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );

  setTimeout(() => controller.abort(), 100);

  try {
    await promise;
    expect.unreachable();
  } catch (e: unknown) {
    expect((e as Error).message).toBe("Subagent was aborted");
  }
});

test("formatAgentList", () => {
  const { formatAgentList } = require("./agents.js");
  const agents = [
    { name: "a1", source: "user", description: "d1" },
    { name: "a2", source: "project", description: "d2" },
  ];

  const res1 = formatAgentList(agents, 1);
  expect(res1.text).toBe("a1 (user): d1");
  expect(res1.remaining).toBe(1);

  const res2 = formatAgentList(agents, 2);
  expect(res2.text).toBe("a1 (user): d1; a2 (project): d2");
  expect(res2.remaining).toBe(0);

  const res0 = formatAgentList([], 10);
  expect(res0.text).toBe("none");
});

test("subagent captures pi output including usage and model", async () => {
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"model":"gpt-4","usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.001}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );

  const tool = getSubagentTool();
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );

  expect((result.content[0] as TextContent).text).toBe("hello");
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.usage.input).toBe(10);
  if (details.results[0]?.model !== "gpt-4")
    expect(details.results[0]?.model).toBe("thinking:off");
});

test("autocomplete provider registers and returns agent suggestions", async () => {
  const { cwd } = await setupFakePi();
  let sessionStartHandler:
    | ((event: string, ctx: ExtensionContext) => void)
    | undefined;
  const fakePi = {
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        sessionStartHandler = handler as (
          event: string,
          ctx: ExtensionContext,
        ) => void;
      }
    },
    registerTool() {},
    getThinkingLevel() {
      return "off";
    },
  } as unknown as ExtensionAPI;

  registerSubagentExtension(fakePi);
  expect(sessionStartHandler).toBeDefined();

  let factoryFn: AutocompleteProviderFactory | undefined;
  const fakeCtx = {
    cwd,
    ui: {
      addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
        factoryFn = factory;
      },
    },
  };

  sessionStartHandler?.(
    "session_start",
    fakeCtx as unknown as ExtensionContext,
  );
  expect(factoryFn).toBeDefined();

  const fakeCurrentProvider = {
    getSuggestions: async () => ({ prefix: "fake", items: [] }),
    applyCompletion: () => ({
      lines: ["applied"],
      cursorLine: 0,
      cursorCol: 7,
    }),
    shouldTriggerFileCompletion: () => false,
  };

  const registeredProvider = factoryFn?.(
    fakeCurrentProvider as unknown as Parameters<AutocompleteProviderFactory>[0],
  );

  // Create an agent to test
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "test-agent.md"),
    `---
name: test-agent
description: test
---
Prompt`,
  );

  // Test getSuggestions matches
  const suggestions = await registeredProvider?.getSuggestions(
    ["/run te"],
    0,
    7,
    { signal: new AbortController().signal },
  );
  expect(suggestions?.prefix).toBe("te");
  expect(suggestions?.items).toEqual([
    { value: "test-agent", label: "test-agent" },
  ]);

  // Test getSuggestions no match
  const noMatch = await registeredProvider?.getSuggestions(
    ["other text "],
    0,
    11,
    { signal: new AbortController().signal },
  );
  expect(noMatch?.prefix).toBe("fake");

  // Test applyCompletion falls back
  const applied = registeredProvider?.applyCompletion(
    [],
    0,
    0,
    { value: "test", label: "test" },
    "",
  );
  expect(applied?.lines).toEqual(["applied"]);

  // Test shouldTriggerFileCompletion falls back
  const trigger = registeredProvider?.shouldTriggerFileCompletion?.([], 0, 0);
  expect(trigger).toBe(false);

  // Test shouldTriggerFileCompletion undefined fallback
  const fallbackProvider = factoryFn?.({
    getSuggestions: async () => ({ prefix: "", items: [] }),
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
  } as unknown as Parameters<AutocompleteProviderFactory>[0]);
  expect(fallbackProvider?.shouldTriggerFileCompletion?.([], 0, 0)).toBe(true);
});
