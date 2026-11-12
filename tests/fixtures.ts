import { afterEach, beforeEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ThinkingLevel } from "../src/agent/agents.js";
import type { ModelRegistry } from "../src/child/model-resolution.js";
import type { RuntimeResult } from "../src/child/result-builder.js";
import type { SingleResult, SubagentDetails } from "../src/shared/types.js";
import { restoreTestGlobals } from "./test-globals.js";

export interface SummaryFixture {
  name: string;
  finalOutput: string;
  outcome?: string;
  expectedSummary: string;
  expectedProgress: string;
}

export const CANONICAL_SUMMARY_FIXTURES: SummaryFixture[] = [
  {
    name: "explicit outcome wins over finalOutput",
    finalOutput: "ignored output",
    outcome: "My Typed Outcome!",
    expectedSummary: "my typed outcome",
    expectedProgress: "my typed outcome",
  },
  {
    name: "status-only explicit outcome maps to completed task in progress",
    finalOutput: "ignored output",
    outcome: "Success",
    expectedSummary: "success",
    expectedProgress: "completed task",
  },
  {
    name: "label-prefixed result line",
    finalOutput: "Result: needs follow-up review",
    expectedSummary: "needs follow-up review",
    expectedProgress: "needs follow-up review",
  },
  {
    name: "outcome label with preamble",
    finalOutput: "noise\nOutcome: completed requested fix",
    expectedSummary: "outcome: completed requested fix",
    expectedProgress: "outcome: completed requested fix",
  },
  {
    name: "markdown heading and bullet",
    finalOutput: "## Summary:\n- Outcome: **Rendered custom card body**",
    expectedSummary: "outcome: **rendered custom card body**",
    expectedProgress: "outcome: **rendered custom card body**",
  },
  {
    name: "status-only success uppercase",
    finalOutput: "SUCCESS",
    expectedSummary: "completed task",
    expectedProgress: "completed task",
  },
  {
    name: "status-only done",
    finalOutput: "DONE",
    expectedSummary: "completed task",
    expectedProgress: "completed task",
  },
  {
    name: "generic statuses filtered",
    finalOutput: "Summary\nStatus: success\nDone",
    expectedSummary: "completed task",
    expectedProgress: "completed task",
  },
  {
    name: "label-prefixed success becomes completed task",
    finalOutput: "Status: DONE",
    expectedSummary: "completed task",
    expectedProgress: "completed task",
  },
  {
    name: "nested status and label",
    finalOutput: "SUCCESS: Result: implemented fix",
    expectedSummary: "implemented fix",
    expectedProgress: "implemented fix",
  },
  {
    name: "long text truncates at canonical limit",
    finalOutput: `Outcome: Implemented ${"semantic result ".repeat(20)}for run cards.`,
    expectedSummary:
      "outcome: implemented semantic result semantic result semantic result semantic result semantic result semantic result se…",
    expectedProgress:
      "outcome: implemented semantic result semantic result semantic result semantic result semantic result semantic result se…",
  },
];

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

let fixtureTempDirs: string[] = [];
const fixturePidLogs = new Set<string>();

/**
 * Registers a log that fixture children append their PID to as they start, so
 * case teardown terminates the process group each one leads—including a
 * descendant whose case failed before reaching its own cancellation.
 */
export function registerFixturePidLog(file: string): void {
  fixturePidLogs.add(file);
}

export type FakeTheme = {
  fg: (color: ThemeColor | string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
  italic?: (text: string) => string;
};

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  fixtureTempDirs.push(dir);
  return dir;
}

/** Default fixture agent markdown shared by discovery and fake-pi fixtures. */
export const HANG_AGENT_MD = `---
name: hang
description: Test agent
thinking: off
---
Test agent prompt.
`;

function eaccesError(syscall: string, target: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `EACCES: permission denied, ${syscall} '${target}'`,
  );
  error.code = "EACCES";
  error.syscall = syscall;
  error.path = target;
  return error;
}

function isInside(target: unknown, root: string): boolean {
  return (
    typeof target === "string" &&
    path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`)
  );
}

function isAtOrInside(target: unknown, root: string): boolean {
  return (
    (typeof target === "string" &&
      path.resolve(target) === path.resolve(root)) ||
    isInside(target, root)
  );
}

/**
 * Simulates `chmod 0o000` on `root` by failing `fs/promises` reads with
 * `EACCES`. Root ignores mode bits, so real `chmod` cannot exercise
 * permission paths in containers that run tests as root.
 */
export function denyFsAccess(root: string): { restore: () => void } {
  const { readFile, readdir, stat } = fsPromises;
  const spies = [
    spyOn(fsPromises, "readFile").mockImplementation(((
      ...args: Parameters<typeof readFile>
    ) =>
      isAtOrInside(args[0], root)
        ? Promise.reject(eaccesError("open", String(args[0])))
        : readFile(...args)) as typeof readFile),
    spyOn(fsPromises, "readdir").mockImplementation(((
      ...args: Parameters<typeof readdir>
    ) =>
      isAtOrInside(args[0], root)
        ? Promise.reject(eaccesError("scandir", String(args[0])))
        : readdir(...args)) as typeof readdir),
    spyOn(fsPromises, "stat").mockImplementation(((
      ...args: Parameters<typeof stat>
    ) =>
      isInside(args[0], root)
        ? Promise.reject(eaccesError("stat", String(args[0])))
        : stat(...args)) as typeof stat),
  ];
  return {
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
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

/** Build a minimal assistant message with given content items. */
export function assistantMessage(content: unknown[]): Message {
  return {
    role: "assistant",
    content: content as Message extends { role: "assistant" }
      ? Message["content"]
      : never,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-3-5-sonnet-latest",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as Message;
}

/** Build a minimal user message with empty content. */
export function userMessage(): Message {
  return {
    role: "user",
    content: [],
    timestamp: Date.now(),
  } as unknown as Message;
}

/** Build a minimal tool-result message for the fixed `tc1` tool call. */
export function toolResultMessage(isError = false): Message {
  return {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "test",
    content: [],
    isError,
    timestamp: Date.now(),
  } as unknown as Message;
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
/** Emits `agent_end`; omitting `messages` emits the bare event. */
export function emitAgentEnd(messages?: Record<string, unknown>[]): string {
  const event =
    messages === undefined
      ? { type: "agent_end" }
      : { type: "agent_end", messages };
  return `printf '%s\\n' ${shellQuote(JSON.stringify(event))}`;
}

export type SendMessageArg = Parameters<ExtensionAPI["sendMessage"]>[0];

/**
 * Returns the first sent message's `details.requestId`, throwing when the
 * message, its details, or the request id is absent.
 */
export function requestIdOf(sentMessages: SendMessageArg[]): string {
  const details = sentMessages[0]?.details as
    | { requestId?: string }
    | undefined;
  const requestId = details?.requestId;
  if (!requestId) throw new Error("requestId missing");
  return requestId;
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
 * Builds a `RuntimeResult` fixture on `makeSingleResult` defaults with
 * `messages` defaulting to empty; explicit overrides win over every default.
 */
export function makeRuntimeResult(
  overrides: Partial<RuntimeResult> = {},
): RuntimeResult {
  const base = makeSingleResult(overrides as Partial<SingleResult>);
  if (!("messages" in base)) {
    (base as RuntimeResult).messages = [];
  }
  return base as RuntimeResult;
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

/**
 * Builds the canonical unconfirmed-thinking-level warning string.
 * Mirrors the production format from `model-resolution.ts`.
 */
export function unconfirmedWarning(
  requested: ThinkingLevel,
  provider?: string,
  modelId?: string,
): string {
  const providerLabel = provider ?? "unknown";
  const modelLabel = modelId ?? "unknown";
  return `Thinking level "${requested}" support could not be confirmed; requesting as-is (provider: ${providerLabel}, model: ${modelLabel})`;
}

export type FixtureHooks = {
  /**
   * Removes registered fixtures and restores shared globals; registered as
   * `afterEach`, and callable directly to verify cleanup in isolation.
   */
  teardown: () => Promise<void>;
};

/**
 * Per-case hooks for temp trees, fixture children, `argv`, and env, plus each
 * module-state `reset` a suite owns, run before every case and in teardown.
 * Takes resets instead of importing `src`, so builder-only suites load no
 * source graph.
 */
export function setupFixtureHooks(
  ...resets: ReadonlyArray<() => void>
): FixtureHooks {
  const runResets = (): void => {
    for (const reset of resets) reset();
  };
  beforeEach(() => {
    fixtureTempDirs = [];
    runResets();
    process.env.PI_SUBAGENT_DEPTH = "0";
    process.env.PI_SUBAGENT_DESKTOP_NOTIFICATIONS = "0";
    delete process.env.PI_SUBAGENT_DEBUG_ENABLED;
  });
  const teardown = async (): Promise<void> => {
    restoreTestGlobals();
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
    runResets();
    await cleanupFixtureTempDirs();
  };
  afterEach(teardown);
  return { teardown };
}

const FIXTURE_PROCESS_EXIT_TIMEOUT_MS = 2000;

function isProcessRunning(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

function signalFixtureProcess(target: number): boolean {
  try {
    process.kill(target, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the PIDs a fixture child logged, tolerating a log that was never
 * written; a case that fails before any child starts owns nothing. An
 * unterminated tail is a partial append and names no complete PID.
 */
async function readFixturePids(file: string): Promise<number[]> {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch {
    return [];
  }
  const lines = text.split("\n");
  lines.pop();
  const pids: number[] = [];
  for (const line of lines) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * Kills the process group `pid` leads so its descendants die with it, then
 * awaits the group's disappearance. Children spawn detached on `POSIX`, so the
 * group probe covers descendants; elsewhere only the process stands alone, and
 * an already-exited leader leaves nothing to kill.
 */
async function terminateFixtureProcessGroup(pid: number): Promise<void> {
  const group = process.platform === "win32" ? pid : -pid;
  if (!signalFixtureProcess(group)) signalFixtureProcess(pid);
  const deadline = Date.now() + FIXTURE_PROCESS_EXIT_TIMEOUT_MS;
  while (isProcessRunning(group) || (group !== pid && isProcessRunning(pid))) {
    if (Date.now() > deadline) {
      throw new Error(`Fixture child process group ${pid} outlived SIGKILL`);
    }
    await Bun.sleep(5);
  }
}

/**
 * Terminates every fixture child a case started, awaiting each group's exit, so
 * no descendant survives the case on success or failure.
 */
async function terminateFixtureProcesses(): Promise<void> {
  const pids = new Set<number>();
  for (const log of fixturePidLogs) {
    for (const pid of await readFixturePids(log)) pids.add(pid);
  }
  fixturePidLogs.clear();
  await Promise.all([...pids].map(terminateFixtureProcessGroup));
}

/**
 * Terminates fixture children, then cleans fixture temp dirs without src
 * resets; for harness teardown reuse. Child trees go first: removal must never
 * race a live child or hide the PID logs that name it.
 */
export async function cleanupFixtureTempDirs(): Promise<void> {
  await terminateFixtureProcesses();
  await Promise.all(
    fixtureTempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  fixtureTempDirs = [];
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
 * Includes an empty model registry so agents with an explicit
 * provider/model don't trip the real
 * "Live model registry unavailable" console.warn diagnostic.
 */
export function makeBareCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    modelRegistry: registryFixture([]),
  } as unknown as ExtensionContext;
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

export function makeMessageRenderOptions(): {
  expanded: boolean;
  outputPad: number;
  keyText: (keybinding: string) => string;
  keyHint: (keybinding: string, description: string) => string;
} {
  return {
    expanded: false,
    outputPad: 2,
    keyText: (keybinding) => keybinding,
    keyHint: (keybinding, description) => `${keybinding} ${description}`,
  };
}
