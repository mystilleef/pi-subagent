import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerSubagentExtension from "./index.js";

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

type CapturedSubagentTool = RegisteredTool & {
  execute: (
    toolCallId: string,
    params: { agent: string; task: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string; hasUI: false },
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

function getSubagentTool(): CapturedSubagentTool {
  let registeredTool: RegisteredTool | undefined;
  const fakePi = {
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
    { cwd, hasUI: false },
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

  expect(result.content[0]).toEqual({ type: "text", text: "done" });
});

test("subagent resolves when fake pi emits agent_end but stays alive", async () => {
  const controller = new AbortController();
  const run = executeSubagent("agent-end-no-exit", controller.signal);

  const result = await Promise.race([
    run,
    timeoutAfter(500, () => controller.abort()),
  ]);

  expect(result.content[0]).toEqual({ type: "text", text: "done" });
});
