import { afterEach, beforeEach } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerSubagentExtension, {
  resetAgentCache,
  type SubagentParams,
} from "../src/index.js";
import { listRunJobs } from "../src/orchestration/run-registry.js";
import type { SubagentDetails } from "../src/shared/types.js";

const ORIGINAL_ARGV_1 = process.argv[1] ?? "";
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const ORIGINAL_SUBAGENT_DEPTH = process.env.PI_SUBAGENT_DEPTH;

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
  const tool = getSubagentTool({ sendMessage: overrides?.sendMessage });
  return { binDir, cwd, agentDir, tool };
}

export type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

export type CapturedSubagentTool = ToolDefinition<
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

export type RegisteredCommandOptions = Parameters<
  ExtensionAPI["registerCommand"]
>[1];
export type RegisteredMessageRenderer = Parameters<
  ExtensionAPI["registerMessageRenderer"]
>[1];

export function getSubagentTool(overrides?: {
  sendMessage?: (msg: SendMessageArg) => void;
  thinkingLevel?: string;
}): CapturedSubagentTool & {
  registeredCommands: Map<string, RegisteredCommandOptions>;
  registeredMessageRenderers: Map<string, RegisteredMessageRenderer>;
} {
  let registeredTool: RegisteredTool | undefined;
  const registeredCommands = new Map<string, RegisteredCommandOptions>();
  const registeredMessageRenderers = new Map<
    string,
    RegisteredMessageRenderer
  >();
  const fakePi = {
    on() {},
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
    registeredMessageRenderers,
  });
}

export function setupHooks() {
  beforeEach(() => {
    tempDirs = [];
    process.env.PI_SUBAGENT_DEPTH = "0";
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
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
}
