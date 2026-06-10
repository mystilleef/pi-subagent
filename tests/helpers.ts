import { afterEach, beforeEach } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agent/agents.js";
import registerSubagentExtension, {
  resetAgentCache,
  type SubagentParams,
} from "../src/index.js";
import {
  resetDefaultDeliveryDeps,
  resetNotifySendCache,
} from "../src/notification/delivery.js";
import { listRunJobs } from "../src/orchestration/run-registry.js";
import type { SubagentDetails } from "../src/shared/types.js";

const ORIGINAL_ARGV_1 = process.argv[1] ?? "";
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_SUBAGENT_DEPTH = process.env.PI_SUBAGENT_DEPTH;
const ORIGINAL_AGENT_END_GRACE_MS = process.env.PI_SUBAGENT_AGENT_END_GRACE_MS;
const ORIGINAL_MAX_STDERR_BYTES = process.env.PI_SUBAGENT_MAX_STDERR_BYTES;
const ORIGINAL_MAX_DEPTH = process.env.PI_SUBAGENT_MAX_DEPTH;
const ORIGINAL_DEBUG_ENABLED = process.env.PI_SUBAGENT_DEBUG_ENABLED;
const ORIGINAL_DESKTOP_NOTIFICATIONS =
  process.env.PI_SUBAGENT_DESKTOP_NOTIFICATIONS;
const ORIGINAL_NOTIFY_PER_JOB = process.env.PI_SUBAGENT_NOTIFY_PER_JOB;

let tempDirs: string[] = [];

export type FakeTheme = {
  fg: (color: ThemeColor | string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
  italic?: (text: string) => string;
};

export async function waitFor<T>(
  predicate: () => T | undefined | false,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function waitForRunJobCount(count: number) {
  await waitFor(
    () => listRunJobs().length >= count,
    `${count} active /run job(s)`,
  );
}

export async function waitForRunJobsCleared() {
  await waitFor(
    () => listRunJobs().length === 0 || undefined,
    "active /run jobs cleared",
  );
}

export async function waitForSentMessage(sentMessages: SendMessageArg[]) {
  await waitFor(() => sentMessages[0], "first sent message");
}

export async function waitForSentMessageCount(
  sentMessages: SendMessageArg[],
  count: number,
) {
  await waitFor(
    () => sentMessages.length >= count || undefined,
    `${count} sent message(s)`,
  );
}

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function makeSubagentToolUpdateLine(
  preview: string,
  instanceName?: string,
  toolName = "subagent",
): string {
  const result: Record<string, unknown> = {
    progress: {
      toolCalls: [],
      lastToolPreview: preview,
      activityText: preview,
      activeToolActivity: { toolName: "tool", inputSummary: preview },
    },
  };
  if (instanceName !== undefined) result["instanceName"] = instanceName;
  return JSON.stringify({
    type: "tool_execution_update",
    toolName,
    partialResult: {
      content: [{ type: "text", text: preview }],
      details: { results: [result] },
    },
  });
}

export async function setupFakePi(): Promise<{
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
  resetAgentCache();
  return { agentDir, cwd, binDir };
}

export type SendMessageArg = Parameters<ExtensionAPI["sendMessage"]>[0];

export async function setupTest(overrides?: {
  sendMessage?: (msg: SendMessageArg) => void;
  piScript?: string;
}) {
  const { binDir, cwd, agentDir } = await setupFakePi();
  if (overrides?.piScript) {
    await writeFile(path.join(binDir, "pi"), overrides.piScript);
    await chmod(path.join(binDir, "pi"), 0o755);
  }
  const tool = getSubagentTool(
    overrides?.sendMessage !== undefined
      ? { sendMessage: overrides.sendMessage }
      : undefined,
  );
  return { binDir, cwd, agentDir, tool };
}

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

export type CapturedSubagentTool = Omit<
  ToolDefinition<typeof SubagentParams, SubagentDetails>,
  "renderCall" | "renderResult"
> & {
  renderCall: NonNullable<
    ToolDefinition<typeof SubagentParams, SubagentDetails>["renderCall"]
  >;
  renderResult: NonNullable<
    ToolDefinition<typeof SubagentParams, SubagentDetails>["renderResult"]
  >;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<SubagentDetails>>;
};

export type RegisteredCommandOptions = Parameters<
  ExtensionAPI["registerCommand"]
>[1];
export type RegisteredMessageRenderer = Parameters<
  ExtensionAPI["registerMessageRenderer"]
>[1];
export type RegisteredEventHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown;

export function getSubagentTool(overrides?: {
  sendMessage?: (msg: SendMessageArg) => void;
  thinkingLevel?: string;
}): CapturedSubagentTool & {
  registeredCommands: Map<string, RegisteredCommandOptions>;
  registeredEventHandlers: Map<string, RegisteredEventHandler[]>;
  registeredMessageRenderers: Map<string, RegisteredMessageRenderer>;
} {
  let registeredTool: RegisteredTool | undefined;
  const registeredCommands = new Map<string, RegisteredCommandOptions>();
  const registeredEventHandlers = new Map<string, RegisteredEventHandler[]>();
  const registeredMessageRenderers = new Map<
    string,
    RegisteredMessageRenderer
  >();
  const fakePi = {
    on(event: string, handler: RegisteredEventHandler) {
      const handlers = registeredEventHandlers.get(event) ?? [];
      handlers.push(handler);
      registeredEventHandlers.set(event, handlers);
    },
    registerTool(tool: RegisteredTool) {
      registeredTool = tool;
    },
    registerCommand(name: string, command: RegisteredCommandOptions) {
      registeredCommands.set(name, command);
    },
    getThinkingLevel() {
      return overrides?.thinkingLevel ?? "off";
    },
    registerMessageRenderer(name: string, renderer: RegisteredMessageRenderer) {
      registeredMessageRenderers.set(name, renderer);
    },
    sendMessage: overrides?.sendMessage ?? (() => {}),
  } as unknown as ExtensionAPI;
  registerSubagentExtension(fakePi);
  if (!registeredTool) throw new Error("subagent tool was not registered");
  return Object.assign(registeredTool as CapturedSubagentTool, {
    registeredCommands,
    registeredEventHandlers,
    registeredMessageRenderers,
  });
}

export function setupHooks() {
  beforeEach(() => {
    tempDirs = [];
    process.env.PI_SUBAGENT_DEPTH = "0";
    process.env.PI_SUBAGENT_DESKTOP_NOTIFICATIONS = "0";
    delete process.env.PI_SUBAGENT_DEBUG_ENABLED;
  });
  afterEach(async () => {
    process.argv[1] = ORIGINAL_ARGV_1;
    if (ORIGINAL_PATH === undefined) delete process.env.PATH;
    else process.env.PATH = ORIGINAL_PATH;
    if (ORIGINAL_AGENT_DIR === undefined)
      delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
    if (ORIGINAL_SUBAGENT_DEPTH === undefined)
      delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = ORIGINAL_SUBAGENT_DEPTH;
    if (ORIGINAL_AGENT_END_GRACE_MS === undefined)
      delete process.env.PI_SUBAGENT_AGENT_END_GRACE_MS;
    else
      process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = ORIGINAL_AGENT_END_GRACE_MS;
    if (ORIGINAL_MAX_STDERR_BYTES === undefined)
      delete process.env.PI_SUBAGENT_MAX_STDERR_BYTES;
    else process.env.PI_SUBAGENT_MAX_STDERR_BYTES = ORIGINAL_MAX_STDERR_BYTES;
    if (ORIGINAL_MAX_DEPTH === undefined)
      delete process.env.PI_SUBAGENT_MAX_DEPTH;
    else process.env.PI_SUBAGENT_MAX_DEPTH = ORIGINAL_MAX_DEPTH;
    if (ORIGINAL_DEBUG_ENABLED === undefined)
      delete process.env.PI_SUBAGENT_DEBUG_ENABLED;
    else process.env.PI_SUBAGENT_DEBUG_ENABLED = ORIGINAL_DEBUG_ENABLED;
    if (ORIGINAL_DESKTOP_NOTIFICATIONS === undefined)
      delete process.env.PI_SUBAGENT_DESKTOP_NOTIFICATIONS;
    else
      process.env.PI_SUBAGENT_DESKTOP_NOTIFICATIONS =
        ORIGINAL_DESKTOP_NOTIFICATIONS;
    if (ORIGINAL_NOTIFY_PER_JOB === undefined)
      delete process.env.PI_SUBAGENT_NOTIFY_PER_JOB;
    else process.env.PI_SUBAGENT_NOTIFY_PER_JOB = ORIGINAL_NOTIFY_PER_JOB;
    resetNotifySendCache();
    resetDefaultDeliveryDeps();
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
}

export const hangAgent: AgentConfig = {
  name: "hang",
  description: "Test agent",
  thinking: "off",
  systemPrompt: "Test agent prompt.",
  source: "user",
  filePath: "hang.md",
};

export const makeSubagentDetails = (
  results: SubagentDetails["results"],
): SubagentDetails => ({
  mode: "single",
  agentScope: "both",
  projectAgentsDir: null,
  results,
});

export function createDefaultFakeTheme(): FakeTheme {
  return {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
}

function createCommandFakeTheme(): FakeTheme {
  return {
    fg: (color, text) => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color, text) => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text) => `<b>${text}</b>`,
    italic: (text) => `<i>${text}</i>`,
  };
}

export function makeCommandContext(
  notify: (msg: string) => void,
  renderWidth = 80,
): ExtensionCommandContext {
  const theme = createCommandFakeTheme();
  return {
    cwd: "/tmp",
    ui: {
      notify,
      custom: async (factory) => {
        let result = "";
        const component = await factory(
          undefined as never,
          theme as never,
          undefined as never,
          (value) => {
            result = value as string;
          },
        );
        component.render(renderWidth);
        return result;
      },
    } as ExtensionCommandContext["ui"],
  } as ExtensionCommandContext;
}
