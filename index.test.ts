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
  ThemeColor,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import registerSubagentExtension, { type SubagentParams } from "./index.js";
import type { SubagentDetails } from "./types.js";

const ORIGINAL_ARGV_1 = process.argv[1] ?? "";
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

let tempDirs: string[] = [];

type FakeTheme = {
  fg: (color: ThemeColor | string, text: string) => string;
  bold: (text: string) => string;
};

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

  // Explicit "user" scope should NOT find project agent
  const promiseUser = tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "user" },
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

test("renderResult output aggregation and truncation", () => {
  const tool = getSubagentTool();

  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };

  const fakeContext = {} as unknown as ExtensionContext;

  // We need to mock a result with some messages
  const messages = [
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "thought 1" },
        {
          type: "toolCall" as const,
          name: "bash",
          arguments: { command: "ls -la" },
          id: "1",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "tool result" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "bash",
          arguments: { command: "ls -l" },
          id: "2",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "tool result 2" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "read",
          arguments: { path: "file1.txt" },
          id: "3",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "file contents" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "read",
          arguments: { path: "file2.txt" },
          id: "4",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "file contents 2" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "read",
          arguments: { path: "file3.txt" },
          id: "5",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "file contents 3" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "final text line 1\nfinal text line 2\nfinal text line 3\nfinal text line 4",
        },
      ],
    },
  ];

  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 0,
          stopReason: "stop",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };

  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: false, isPartial: false },
    fakeTheme as never,
    fakeContext as never,
  );
  // In the collapsed mode, renderResult returns a Text component (or similar)
  // Let's inspect its text content if it's a Text component
  // Or we can just log it
  expect((rendered as unknown as { text: string }).text).toContain(
    "[success]✓[/success] [toolTitle]*test-agent*[/toolTitle][muted] (user)[/muted]",
  );

  // Shows the last tool call only (read file3.txt)
  expect((rendered as unknown as { text: string }).text).toContain(
    "[accent]read[/accent][dim] file3.txt[/dim]",
  );
  expect((rendered as unknown as { text: string }).text).not.toContain(
    "[accent]bash[/accent]",
  );

  // Final output preview: first 2 lines only
  expect((rendered as unknown as { text: string }).text).toContain(
    "final text line 1\nfinal text line 2[/toolOutput]",
  );
  expect((rendered as unknown as { text: string }).text).not.toContain(
    "final text line 3",
  );
});

test("renderResult expanded output", () => {
  const tool = getSubagentTool();

  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };

  const fakeContext = {} as unknown as ExtensionContext;

  const messages = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "bash",
          arguments: { command: "ls -la" },
          id: "1",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "result" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "final output line\nvery long output that would be truncated if it was collapsed",
        },
      ],
    },
  ];

  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 1,
          stopReason: "error",
          errorMessage: "some error",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };

  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: true, isPartial: false },
    fakeTheme as never,
    fakeContext as never,
  );
  const text = (rendered as unknown as { text: string }).text;
  expect(text).toContain(
    "[error]✗[/error] [toolTitle]*test-agent*[/toolTitle][muted] (user)[/muted] [error][error][/error]",
  );
  expect(text).toContain("[error]Error: some error[/error]");
});

test("subagent updates correctly format tool calls and final text", async () => {
  const { binDir, cwd } = await setupFakePi();

  // We mock a pi executable that emits some intermediate events
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[]}}'
printf '%s\n' '{"type":"content_block_start","index":0,"contentBlock":{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"user","content":[]}}'
printf '%s\n' '{"type":"content_block_start","index":0,"contentBlock":{"type":"text","text":"result"}}'
printf '%s\n' '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"result"}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[]}}'
printf '%s\n' '{"type":"content_block_start","index":0,"contentBlock":{"type":"text","text":"final"}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );

  const tool = getSubagentTool();
  const updates: AgentToolResult<SubagentDetails>[] = [];

  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    (update) => updates.push(update),
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );

  // Assert on updates received
  expect(updates.length).toBeGreaterThan(0);
  // Before final message, it should say (running...)
  expect(
    updates.some((u) => (u.content[0] as TextContent)?.text === "(running...)"),
  ).toBe(true);
  // After final message, it should just be "final"
  expect((updates[updates.length - 1]?.content[0] as TextContent)?.text).toBe(
    "final",
  );
});

test("renderResult subagent and unknown tools", () => {
  const tool = getSubagentTool();

  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };

  const messages = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "subagent",
          arguments: { agent: "another-agent" },
          id: "1",
        },
        {
          type: "toolCall" as const,
          name: "unknown",
          arguments: { foo: "bar" },
          id: "2",
        },
        {
          type: "toolCall" as const,
          name: "unknown_long",
          arguments: { foo: "bar".repeat(50) },
          id: "3",
        },
      ],
    },
  ];

  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 0,
          stopReason: "stop",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };

  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: false, isPartial: false },
    fakeTheme as never,
    {} as never,
  );

  // Shows only the last tool call (unknown_long), not earlier ones
  expect((rendered as unknown as { text: string }).text).not.toContain(
    "[accent]subagent[/accent][dim] another-agent[/dim]",
  );
  expect((rendered as unknown as { text: string }).text).not.toContain(
    '[accent]unknown[/accent][dim] {"foo":"bar"}[/dim]',
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "[accent]unknown_long[/accent]",
  );
  // Test arg truncation
  expect((rendered as unknown as { text: string }).text).toContain("...");
});

test("renderResult expanded output truncation for > 2000 chars", () => {
  const tool = getSubagentTool();

  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };

  const messages = [
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "A".repeat(2005) }],
    },
  ];

  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 0,
          stopReason: "stop",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };

  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: true, isPartial: false },
    fakeTheme as never,
    {} as never,
  );

  // Returns a Text node with the final output preview (first 2 lines)
  const text = (rendered as unknown as { text: string }).text;
  expect(text).toBeDefined();
  expect(text).toContain("[toolOutput]AAAA");
});

test("renderCall formats tool execution correctly", () => {
  const tool = getSubagentTool();

  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };

  const rendered = tool.renderCall?.(
    {
      agent: "test-agent",
      task: "long task description that should exceed 60 characters so it gets truncated and ends up shorter",
    },
    fakeTheme as never,
    {} as never,
  );

  expect((rendered as unknown as { text: string }).text).toContain(
    "[toolTitle]*subagent *[/toolTitle][accent]test-agent[/accent][muted] [both][/muted]",
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "long task description that should exceed 60 characters so it...",
  );

  // also test short task and default agent scope
  const renderedShort = tool.renderCall?.(
    { agent: "...", task: "short" },
    fakeTheme as never,
    {} as never,
  );
  expect((renderedShort as unknown as { text: string }).text).toContain(
    "[accent]...[/accent]",
  );
  expect((renderedShort as unknown as { text: string }).text).toContain(
    "[dim]short[/dim]",
  );
});

test("subagent updates correctly hits default running status", async () => {
  const { binDir, cwd } = await setupFakePi();

  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );

  const tool = getSubagentTool();
  const updates: AgentToolResult<SubagentDetails>[] = [];

  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    (update) => updates.push(update),
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );

  expect(
    updates.some((u) => (u.content[0] as TextContent)?.text === "(running...)"),
  ).toBe(true);
});
