import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ThemeColor,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ThinkingLevel } from "../src/agent/agents.js";
import type { ModelRegistry } from "../src/child/model-resolution.js";
import registerSubagentExtension, {
  resetAgentCache,
  type SubagentParams,
} from "../src/index.js";
import {
  resetDefaultDeliveryDeps,
  resetNotifySendCache,
} from "../src/notification/delivery.js";
import {
  listRunJobs,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import type { SingleResult, SubagentDetails } from "../src/shared/types.js";

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

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

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

/**
 * Shell fragment for fake `pi` scripts: captures child argv null-delimited into
 * `args.txt` so multi-line `--append-system-prompt` values (such as the literal
 * result contract) survive as single argv elements, and resolves file-path
 * append values into `prompt.txt`. Literal contract text is not a file path, so
 * the file check safely skips it — proving fake `pi` never treats the contract
 * as a file.
 */
export const CAPTURE_PI_ARGS_SH = `printf '%s\\0' "$@" > args.txt
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--append-system-prompt" ] || [ "$1" = "--system-prompt" ]; then
    shift
    if [ -f "$1" ]; then cat "$1" > prompt.txt; fi
  fi
  shift
done`;

/**
 * A complete fake-pi shell script that captures argv, emits a `message_end`
 * with "done" text, then emits an empty `agent_end` and exits 0.
 * Common pattern used by multiple test files for arg-capture tests.
 */
export const CAPTURE_ARGS_PI_SCRIPT = `#!/bin/sh
printf '%s\n' "$@" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;

/**
 * Reads null-delimited argv captured by `CAPTURE_PI_ARGS_SH` into a `string[]`,
 * dropping the trailing empty element produced by the final delimiter.
 */
export async function readCapturedArgs(
  cwd: string,
  filename = "args.txt",
): Promise<string[]> {
  const text = await Bun.file(path.join(cwd, filename)).text();
  const argv = text.split("\0");
  if (argv[argv.length - 1] === "") argv.pop();
  return argv;
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

/**
 * Builds a minimal assistant message object for fake-pi JSON emission.
 * Merges overrides on top of sensible defaults (fake provider/model/usage).
 */
export function makeAssistantMessage(
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "fake",
    provider: "fake",
    model: "fake",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

/**
 * Shell fragment that emits a `message_end` JSON event line from a message object.
 */
export function emitMessageEnd(message: Record<string, unknown>): string {
  return `printf '%s\\n' ${shellQuote(JSON.stringify({ type: "message_end", message }))}`;
}

/**
 * Shell fragment that emits an `agent_end` JSON event line with the given messages.
 */
export function emitAgentEnd(messages: Record<string, unknown>[]): string {
  return `printf '%s\\n' ${shellQuote(JSON.stringify({ type: "agent_end", messages }))}`;
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

export function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag ? [args[index + 1] ?? ""] : [],
  );
}

export async function withMkdtempCapture<T>(
  callback: (getTmpDir: () => string | undefined) => T | Promise<T>,
): Promise<T> {
  const originalMkdtemp = fs.promises.mkdtemp;
  let tmpDir: string | undefined;
  Object.defineProperty(fs.promises, "mkdtemp", {
    configurable: true,
    value: async (...args: unknown[]) => {
      const dir = Reflect.apply(
        originalMkdtemp,
        fs.promises,
        args,
      ) as Promise<string>;
      tmpDir = await dir;
      return tmpDir;
    },
  });
  try {
    return await callback(() => tmpDir);
  } finally {
    Object.defineProperty(fs.promises, "mkdtemp", {
      value: originalMkdtemp,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

export function captureStdout<T>(
  ttyMode: boolean,
  callback: (writeCalls: string[]) => T | Promise<T>,
): T | Promise<T> {
  const writeCalls: string[] = [];
  const origWrite = process.stdout.write;
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: ttyMode,
    configurable: true,
  });
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (
    s: string,
  ) => {
    writeCalls.push(s);
    return true;
  };
  const restore = () => {
    process.stdout.write = origWrite;
    if (origIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    } else {
      delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
    }
  };
  const result = callback(writeCalls);
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

export function withEnv<T>(
  vars: Record<string, string | undefined>,
  callback: () => T | Promise<T>,
): T | Promise<T> {
  const originals = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    originals.set(key, process.env[key]);
  }
  const restore = () => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const result = callback();
  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }
  restore();
  return result;
}

export function makeSingleResult(
  overrides: Partial<SingleResult> = {},
): SingleResult {
  return {
    agent: "test-agent",
    agentSource: "project",
    task: "test task",
    exitCode: 0,
    finalOutput: "",
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...overrides,
  };
}

/**
 * Creates a minimal Model fixture with sensible defaults.
 * Merge fields override defaults; `id` and `provider` are required.
 */
export function modelFixture(
  fields: Partial<Model<Api>> & { id: string; provider: string },
): Model<Api> {
  return {
    api: "openai-responses",
    name: fields.id,
    baseUrl: "https://api.example.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...fields,
  };
}

/**
 * Creates a ModelRegistry backed by the given model list.
 * Lookup matches on both `provider` and `id`.
 */
export function registryFixture(models: Model<Api>[]): ModelRegistry {
  return {
    find: (provider, modelId) =>
      models.find((m) => m.provider === provider && m.id === modelId),
  };
}

/**
 * Builds the canonical unsupported-thinking-level warning string.
 * Mirrors the production format from `model-resolution.ts`.
 */
export function unsupportedWarning(
  requested: ThinkingLevel,
  effective: ThinkingLevel,
  provider?: string,
  modelId?: string,
): string {
  const providerLabel = provider ?? "unknown";
  const modelLabel = modelId ?? "unknown";
  return `Thinking level "${requested}" is not supported; using "${effective}" instead (provider: ${providerLabel}, model: ${modelLabel})`;
}

export function setupHooks() {
  beforeEach(() => {
    tempDirs = [];
    resetRunRegistry();
    process.env.PI_SUBAGENT_DEPTH = "0";
    process.env.PI_SUBAGENT_DESKTOP_NOTIFICATIONS = "0";
    delete process.env.PI_SUBAGENT_DEBUG_ENABLED;
  });
  afterEach(async () => {
    process.argv[1] = ORIGINAL_ARGV_1;
    restoreEnv("PATH", ORIGINAL_PATH);
    restoreEnv("PI_CODING_AGENT_DIR", ORIGINAL_AGENT_DIR);
    restoreEnv("PI_SUBAGENT_DEPTH", ORIGINAL_SUBAGENT_DEPTH);
    restoreEnv("PI_SUBAGENT_AGENT_END_GRACE_MS", ORIGINAL_AGENT_END_GRACE_MS);
    restoreEnv("PI_SUBAGENT_MAX_STDERR_BYTES", ORIGINAL_MAX_STDERR_BYTES);
    restoreEnv("PI_SUBAGENT_MAX_DEPTH", ORIGINAL_MAX_DEPTH);
    restoreEnv("PI_SUBAGENT_DEBUG_ENABLED", ORIGINAL_DEBUG_ENABLED);
    restoreEnv(
      "PI_SUBAGENT_DESKTOP_NOTIFICATIONS",
      ORIGINAL_DESKTOP_NOTIFICATIONS,
    );
    restoreEnv("PI_SUBAGENT_NOTIFY_PER_JOB", ORIGINAL_NOTIFY_PER_JOB);
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

export function makeModelAgent(overrides: Partial<AgentConfig>): AgentConfig {
  return { ...hangAgent, ...overrides };
}

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

/**
 * Builds a minimal ExtensionContext with `hasUI: false` for the given cwd.
 * Replaces the repeated `{ cwd, hasUI: false } as unknown as ExtensionContext`
 * cast scattered across test files.
 */
export function makeBareCtx(cwd: string): ExtensionContext {
  return { cwd, hasUI: false } as unknown as ExtensionContext;
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
