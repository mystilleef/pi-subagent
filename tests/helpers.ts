import { afterEach, beforeEach, expect } from "bun:test";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agent/agents.js";
import type {
  ChildModelSettings,
  ModelRegistry,
} from "../src/child/model-resolution.js";
import {
  resetDefaultSleepInhibitorAcquirer,
  runSingleAgent,
  setDefaultSleepInhibitorAcquirer,
} from "../src/child/process.js";
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
import { resetUsageLedger } from "../src/orchestration/usage-ledger.js";
import { resetProgressStore } from "../src/progress/progress-state.js";
import {
  resetResolvedAgentExtensionPathsCache,
  resetResolvedAgentSkillArgsCache,
} from "../src/shared/resource-resolution.js";
import type { SingleResult, SubagentDetails } from "../src/shared/types.js";
import {
  emitAgentEnd,
  emitMessageEnd,
  HANG_AGENT_MD,
  hangAgent,
  makeAssistantMessage,
  makeTempDir as makeFixtureTempDir,
  makeSubagentDetails,
  registerFixturePidLog,
  registryFixture,
  setupFixtureHooks,
  shellQuote,
  withEnv,
} from "./fixtures.js";

export {
  assistantMessage,
  captureStdout,
  createDefaultFakeTheme,
  denyFsAccess,
  emitAgentEnd,
  emitMessageEnd,
  type FakeTheme,
  type FixtureHooks,
  flagValues,
  hangAgent,
  makeAssistantMessage,
  makeBareCtx,
  makeCommandContext,
  makeMessageRenderOptions,
  makeModelAgent,
  makeRuntimeResult,
  makeSingleResult,
  makeSubagentDetails,
  makeSubagentToolUpdateLine,
  makeTempDir,
  modelFixture,
  registryFixture,
  requestIdOf,
  type SendMessageArg,
  setupFixtureHooks,
  shellQuote,
  toolResultMessage,
  unconfirmedWarning,
  unsupportedWarning,
  userMessage,
  withEnv,
  withMkdtempCapture,
} from "./fixtures.js";

import type { SendMessageArg } from "./fixtures.js";

const ORIGINAL_PATH = process.env.PATH;

/**
 * Polls `predicate` until it holds, for registry state that carries no
 * delivery event of its own. Every other wait synchronizes on the event or
 * barrier that produces its state.
 */
export async function waitFor<T>(
  predicate: () => T | undefined | false,
  label: string,
): Promise<T> {
  const immediate = predicate();
  if (immediate) return immediate;
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

const DELIVERY_WAIT_TIMEOUT_MS = 2000;

type DeliveryWaiter = {
  isSatisfied: () => boolean;
  resolve: () => void;
};

/**
 * Settles every pending wait whose delivery condition now holds. Each event
 * source calls it as it delivers, so each wait resolves on the delivery
 * instead of polling for it.
 */
function settleWaiters(waiters: Set<DeliveryWaiter>): void {
  for (const waiter of [...waiters]) {
    if (!waiter.isSatisfied()) continue;
    waiters.delete(waiter);
    waiter.resolve();
  }
}

/**
 * Resolves on the delivery whose push satisfies `isSatisfied`, including one
 * that already holds. Never polls: `waiters` settles the wait. The bounded
 * guard rejects with `label` when no delivery ever satisfies it.
 */
function awaitSatisfiedDelivery(
  waiters: Set<DeliveryWaiter>,
  isSatisfied: () => boolean,
  label: string,
): Promise<void> {
  if (isSatisfied()) return Promise.resolve();
  const pending = new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const waiter: DeliveryWaiter = {
      isSatisfied,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    };
    timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`Timed out waiting for ${label}`));
    }, DELIVERY_WAIT_TIMEOUT_MS);
    waiters.add(waiter);
  });
  // A wait abandoned at case teardown must not surface as an unhandled
  // rejection; an awaited wait still observes the timeout error.
  pending.catch(() => {});
  return pending;
}

const sentMessageWaiters = new Set<DeliveryWaiter>();

export async function waitForSentMessage(
  sentMessages: SendMessageArg[],
): Promise<void> {
  await awaitSatisfiedDelivery(
    sentMessageWaiters,
    () => sentMessages.length > 0,
    "first sent message",
  );
}

export async function waitForSentMessageCount(
  sentMessages: SendMessageArg[],
  count: number,
): Promise<void> {
  await awaitSatisfiedDelivery(
    sentMessageWaiters,
    () => sentMessages.length >= count,
    `${count} sent message(s)`,
  );
}

/**
 * Resolves once `target` exists, driven by watch events on its parent directory
 * rather than by polling. The bounded guard rejects with `label` when it never
 * appears.
 */
export async function waitForPath(
  target: string,
  label: string,
): Promise<void> {
  if (existsSync(target)) return;
  const directory = path.dirname(target);
  const pending = new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let watcher: FSWatcher;
    const finish = () => {
      clearTimeout(timer);
      watcher.close();
    };
    watcher = watch(directory, () => {
      if (!existsSync(target)) return;
      finish();
      resolve();
    });
    watcher.on("error", (error) => {
      finish();
      reject(error);
    });
    timer = setTimeout(() => {
      finish();
      reject(new Error(`Timed out waiting for ${label}`));
    }, DELIVERY_WAIT_TIMEOUT_MS);
    // The target may appear between the initial check and the first event.
    if (existsSync(target)) {
      finish();
      resolve();
    }
  });
  pending.catch(() => {});
  return pending;
}

export type ProgressRenderBarrier = {
  /** Extension context that settles every progress wait its renders satisfy. */
  ctx: ExtensionContext;
  /**
   * Resolves on the progress render that satisfies `isSatisfied`, including one
   * that already holds. Progress state is patched before the render request, so
   * a settled wait observes the patched state and never polls.
   */
  when: (isSatisfied: () => boolean, label: string) => Promise<void>;
};

/**
 * Event-driven progress barrier for a tool run: the orchestrator requests a
 * progress render after every patch, including patches it does not forward as
 * host updates, so each render settles the waits it satisfies.
 */
export function progressRenderBarrier(
  ctx: ExtensionContext,
): ProgressRenderBarrier {
  const waiters = new Set<DeliveryWaiter>();
  const setStatus = ctx.ui?.setStatus;
  return {
    ctx: {
      ...ctx,
      ui: {
        ...ctx.ui,
        setStatus: (key, status) => {
          settleWaiters(waiters);
          setStatus?.(key, status);
        },
      },
    } as ExtensionContext,
    when: (isSatisfied, label) =>
      awaitSatisfiedDelivery(waiters, isSatisfied, label),
  };
}

/**
 * Shell fragment for fake `pi` scripts: captures child argv null-delimited into
 * `args.txt` so multi-line `--append-system-prompt` values (such as the literal
 * result contract) survive as single argv elements, and resolves file-path
 * append values into `prompt.txt`. Emits one delimiter per argument, so zero
 * arguments capture as an empty file and an empty argument as a lone delimiter.
 * Literal contract text is not a file path, so the file check safely skips it —
 * proving fake `pi` never treats the contract as a file.
 */
export const CAPTURE_PI_ARGS_SH = `for arg in "$@"; do printf '%s\\0' "$arg"; done > args.txt
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--append-system-prompt" ] || [ "$1" = "--system-prompt" ]; then
    shift
    if [ -f "$1" ]; then cat "$1" > prompt.txt; fi
  fi
  shift
done`;

/**
 * A complete fake-pi shell script that captures argv null-delimited, emits a
 * `message_end` with "done" text, then emits an empty `agent_end` and exits 0.
 * Shared null-delimited format preserves multiline prompts and argument
 * boundaries across process and tool consumers.
 */
export const CAPTURE_ARGS_PI_SCRIPT = `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
exit 0
`;

/**
 * Reads null-delimited argv captured by `CAPTURE_PI_ARGS_SH` into a `string[]`,
 * dropping the trailing empty element produced by the final delimiter; an empty
 * capture decodes as zero arguments.
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

/**
 * Writes a fake `pi` executable into `binDir` and marks it mode `0o755`.
 * Overwriting keeps the executable mode, so callers may reinstall scripts.
 * Every script first logs its own PID, so fixture teardown terminates the
 * process group it leads even when a case fails before cancelling its run.
 */
export async function installFakePi(
  binDir: string,
  script: string,
): Promise<void> {
  const piPath = path.join(binDir, "pi");
  const pidLog = path.join(binDir, "fake-pi-pids");
  registerFixturePidLog(pidLog);
  await writeFile(piPath, withPidRegistration(script, pidLog));
  await chmod(piPath, 0o755);
}

/**
 * Inserts PID registration after a fake `pi` script's shebang, so the kernel
 * still execs the script directly and the logged PID leads its own process
 * group. A script without a shebang keeps the registration on line one.
 */
function withPidRegistration(script: string, pidLog: string): string {
  const registration = `printf '%s\\n' "$$" >> ${shellQuote(pidLog)}\n`;
  const shebangEnd = script.startsWith("#!") ? script.indexOf("\n") : -1;
  if (shebangEnd === -1) return `${registration}${script}`;
  return `${script.slice(0, shebangEnd + 1)}${registration}${script.slice(shebangEnd + 1)}`;
}

/**
 * Discovery-only fixture: cleanup-registered home with `agents/` and working
 * directories plus the default fixture agent, and no fake `pi` executable.
 */
export async function makeAgentHome(): Promise<{
  agentDir: string;
  cwd: string;
}> {
  const root = await makeFixtureTempDir("pi-subagent-test-");
  const agentDir = path.join(root, "agent");
  const agentsDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  await Bun.$`mkdir -p ${agentsDir} ${cwd}`;
  await writeFile(path.join(agentsDir, "hang.md"), HANG_AGENT_MD);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetAgentCache();
  return { agentDir, cwd };
}

export async function setupFakePi(): Promise<{
  agentDir: string;
  cwd: string;
  binDir: string;
}> {
  const root = await makeFixtureTempDir("pi-subagent-test-");
  const agentDir = path.join(root, "agent");
  const agentsDir = path.join(agentDir, "agents");
  const binDir = path.join(root, "bin");
  const cwd = path.join(root, "work");
  await Bun.$`mkdir -p ${agentsDir} ${binDir} ${cwd}`;
  await writeFile(path.join(agentsDir, "hang.md"), HANG_AGENT_MD);
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
case "$*" in
  *agent-end-no-exit*) sleep 10 ;;
esac
exit 0
`,
  );
  process.argv[1] = path.join(root, "not-pi");
  process.env.PATH = `${binDir}:${ORIGINAL_PATH ?? ""}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetAgentCache();
  return { agentDir, cwd, binDir };
}

export async function setupTest(overrides?: {
  sendMessage?: (msg: SendMessageArg) => void;
  appendEntry?: (customType: string, data?: unknown) => void;
  piScript?: string;
}) {
  const { binDir, cwd, agentDir } = await setupFakePi();
  if (overrides?.piScript) {
    await installFakePi(binDir, overrides.piScript);
  }
  const tool = getSubagentTool(
    overrides?.sendMessage !== undefined || overrides?.appendEntry !== undefined
      ? {
          ...(overrides?.sendMessage !== undefined
            ? { sendMessage: overrides.sendMessage }
            : {}),
          ...(overrides?.appendEntry !== undefined
            ? { appendEntry: overrides.appendEntry }
            : {}),
        }
      : undefined,
  );
  return { binDir, cwd, agentDir, tool };
}

export type AgentEndTimeoutScenario = {
  result: SingleResult;
  releases: number;
  elapsedMs: number;
};

/**
 * One spawn per distinct agent-end-timeout child behavior: the
 * inhibitor-release and explicit-grace cases share this byte-identical
 * fake-child run so the behavior spawns exactly once per layer. Each
 * caller creates its own runner, preserving per-file scheduling
 * independence and one spawn per owning file.
 */
export function createAgentEndTimeoutScenarioRunner(): () => Promise<AgentEndTimeoutScenario> {
  let sharedAgentEndTimeoutScenario:
    | Promise<AgentEndTimeoutScenario>
    | undefined;
  const runAgentEndTimeoutScenario = (): Promise<AgentEndTimeoutScenario> => {
    sharedAgentEndTimeoutScenario ??= (async () => {
      const scenario = await withEnv(
        { PI_SUBAGENT_AGENT_END_GRACE_MS: "25" },
        async () => {
          let releases = 0;
          const { cwd } = await setupTest({
            piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
          });
          const startedAt = Date.now();
          const { result } = await runSingleAgent(
            cwd,
            [hangAgent],
            "hang",
            "task",
            undefined,
            undefined,
            makeSubagentDetails,
            undefined,
            "off",
            false,
            {
              async acquireSleepInhibitor() {
                return {
                  async release() {
                    releases += 1;
                  },
                };
              },
            },
          );
          return { result, releases, elapsedMs: Date.now() - startedAt };
        },
      );
      return scenario;
    })();
    return sharedAgentEndTimeoutScenario;
  };
  return runAgentEndTimeoutScenario;
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
/**
 * Delegates to the tool's `execute` boundary with the standard test call
 * identity and no update callback, returning results and errors unchanged.
 */
export async function runTool(
  tool: CapturedSubagentTool,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<AgentToolResult<SubagentDetails>> {
  return tool.execute("test-tool-call", params, signal, undefined, ctx);
}

export type RegisteredMessageRenderer = Parameters<
  ExtensionAPI["registerMessageRenderer"]
>[1];

export type RegisteredEventHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown;

/**
 * Dispatches the `session_start` startup event to every registered handler in
 * registration order, awaiting each with the given workspace directory.
 */
export async function emitSessionStart(
  tool: { registeredEventHandlers: Map<string, RegisteredEventHandler[]> },
  cwd: string | undefined,
  options?: {
    reason?: "startup" | "reload" | "new" | "resume" | "fork";
    ctx?: ExtensionContext;
  },
): Promise<void> {
  const ctx =
    options?.ctx ??
    ({
      cwd,
    } as unknown as ExtensionCommandContext);
  for (const handler of tool.registeredEventHandlers.get("session_start") ??
    []) {
    await handler(
      { type: "session_start", reason: options?.reason ?? "startup" },
      ctx,
    );
  }
}

/**
 * Dispatches `session_shutdown` to every registered handler in registration
 * order, as pi does before replacing or reloading a session.
 */
export async function emitSessionShutdown(tool: {
  registeredEventHandlers: Map<string, RegisteredEventHandler[]>;
}): Promise<void> {
  for (const handler of tool.registeredEventHandlers.get("session_shutdown") ??
    []) {
    await handler(
      { type: "session_shutdown", reason: "new" },
      {} as ExtensionContext,
    );
  }
}

export function getSubagentTool(overrides?: {
  sendMessage?: (msg: SendMessageArg) => void;
  appendEntry?: (customType: string, data?: unknown) => void;
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
    sendMessage: (message: SendMessageArg) => {
      overrides?.sendMessage?.(message);
      settleWaiters(sentMessageWaiters);
    },
    ...(overrides?.appendEntry !== undefined
      ? { appendEntry: overrides.appendEntry }
      : {}),
  } as unknown as ExtensionAPI;
  registerSubagentExtension(fakePi);
  if (!registeredTool) throw new Error("subagent tool was not registered");
  return Object.assign(registeredTool as CapturedSubagentTool, {
    registeredCommands,
    registeredEventHandlers,
    registeredMessageRenderers,
  });
}

export type TestHooks = {
  /**
   * Removes registered fixtures and restores shared globals; registered as
   * `afterEach`, and callable directly to verify cleanup in isolation.
   */
  teardown: () => Promise<void>;
};

/** Module state the tool and child layers mutate through the extension. */
function resetHarnessState(): void {
  resetAgentCache();
  resetResolvedAgentSkillArgsCache();
  resetResolvedAgentExtensionPathsCache();
  resetNotifySendCache();
  resetDefaultDeliveryDeps();
  resetRunRegistry();
  resetUsageLedger();
  resetProgressStore();
}

async function noopSleepInhibitorAcquirer(): Promise<{
  release: () => Promise<void>;
}> {
  return {
    async release() {},
  };
}

function installNoopSleepInhibitor(): void {
  setDefaultSleepInhibitorAcquirer(noopSleepInhibitorAcquirer);
}

/**
 * Fixture hooks plus harness state resets and a no-op default sleep
 * inhibitor, so no case spawns a host power-manager helper. The returned
 * teardown performs the same cleanup for direct verification.
 */
export function setupHooks(): TestHooks {
  const fixtureHooks = setupFixtureHooks(resetHarnessState);
  beforeEach(installNoopSleepInhibitor);
  afterEach(resetDefaultSleepInhibitorAcquirer);
  return {
    teardown: async () => {
      resetDefaultSleepInhibitorAcquirer();
      await fixtureHooks.teardown();
    },
  };
}

export type CapturableParentModel = ChildModelSettings | undefined;

/**
 * Runs a single agent under the null-delimited capture script and returns
 * exact argv plus the result; null delimiters keep multi-line prompt values
 * intact as single arguments.
 */
export async function runCapturedModelAgent(
  agent: AgentConfig,
  parentModel?: CapturableParentModel,
  parentThinking?: AgentConfig["thinking"],
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
    options?.registry !== undefined
      ? { registry: options.registry }
      : undefined,
  );
  expect(result.exitCode).toBe(0);
  return {
    args: await readCapturedArgs(cwd),
    result,
  };
}

/**
 * Shared argv-only capture: delegates to `runCapturedModelAgent` with the
 * standard `off` thinking level and returns exact argv.
 */
export async function captureRunSingleAgentArgs(
  agent: AgentConfig,
  parentModel?: CapturableParentModel,
  options: { registry?: ModelRegistry } = { registry: registryFixture([]) },
): Promise<string[]> {
  return (await runCapturedModelAgent(agent, parentModel, "off", options)).args;
}
