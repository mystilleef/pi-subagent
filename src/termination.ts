import type { ChildProcess } from "node:child_process";

export type TerminationSignal = "SIGTERM" | "SIGKILL";

export type TerminationMetadata = {
  cancelRequestedAt: number;
  cancelReason?: string;
  terminationSignal?: TerminationSignal;
  escalated: boolean;
  processTreeKilled: boolean;
  target: "direct" | "tree";
  fallbackCause?: string;
};

type TimerHandle = unknown;

type TerminationState = {
  metadata: TerminationMetadata;
  promise: Promise<TerminationMetadata>;
  settled: boolean;
  timer?: TimerHandle;
  clearTimeout: (timer: TimerHandle) => void;
  resolve: (metadata: TerminationMetadata) => void;
};

export type TerminateChildProcessOptions = {
  reason?: string;
  timeoutMs?: number;
  tree?: boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
  killProcess?: (proc: ChildProcess, signal: TerminationSignal) => unknown;
  processTreeDetached?: boolean;
  killProcessTree?: (
    proc: ChildProcess,
    signal: TerminationSignal,
    platform: NodeJS.Platform,
  ) => unknown;
  killProcessGroup?: (pid: number, signal: TerminationSignal) => unknown;
  runTaskkill?: (args: string[]) => unknown;
};

const DEFAULT_TIMEOUT_MS = 4_000;
const terminationStates = new WeakMap<ChildProcess, TerminationState>();

export function getProcessTreeSpawnOptions(
  tree: boolean,
  platform: NodeJS.Platform = process.platform,
): { detached?: boolean } {
  return tree && platform !== "win32" ? { detached: true } : {};
}

function childHasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode != null;
}

function hasPid(proc: ChildProcess): proc is ChildProcess & { pid: number } {
  return typeof proc.pid === "number" && Number.isFinite(proc.pid);
}

function settleState(state: TerminationState): void {
  if (state.settled) return;
  state.settled = true;
  if (state.timer) state.clearTimeout(state.timer);
  state.timer = undefined;
  state.resolve(state.metadata);
}

function makeState(
  proc: ChildProcess,
  options: TerminateChildProcessOptions,
): TerminationState {
  let resolveState!: (metadata: TerminationMetadata) => void;
  const metadata: TerminationMetadata = {
    cancelRequestedAt: options.now?.() ?? Date.now(),
    cancelReason: options.reason,
    escalated: false,
    processTreeKilled: false,
    target: options.tree ? "tree" : "direct",
  };
  const state: TerminationState = {
    metadata,
    promise: new Promise((resolve) => {
      resolveState = resolve;
    }),
    settled: false,
    clearTimeout:
      options.clearTimeout ?? ((timer) => clearTimeout(timer as never)),
    resolve: resolveState,
  };
  const settle = () => settleState(state);
  proc.once("exit", settle);
  proc.once("close", settle);
  proc.once("error", settle);
  return state;
}

function sendDirectSignal(
  proc: ChildProcess,
  signal: TerminationSignal,
  state: TerminationState,
  options: TerminateChildProcessOptions,
): void {
  (options.killProcess ?? ((child, nextSignal) => child.kill(nextSignal)))(
    proc,
    signal,
  );
  state.metadata.target = "direct";
  state.metadata.processTreeKilled = false;
}

function sendTreeSignal(
  proc: ChildProcess,
  signal: TerminationSignal,
  state: TerminationState,
  options: TerminateChildProcessOptions,
): void {
  const platform = options.platform ?? process.platform;
  if (!hasPid(proc)) throw new Error("missing child PID");
  const pid = proc.pid;
  if (!options.tree) {
    sendDirectSignal(proc, signal, state, options);
    return;
  }
  const markTreeKilled = () => {
    state.metadata.target = "tree";
    state.metadata.processTreeKilled = true;
  };
  if (options.killProcessTree) {
    options.killProcessTree(proc, signal, platform);
    markTreeKilled();
    return;
  }
  if (platform !== "win32") {
    if (!options.processTreeDetached)
      throw new Error("process tree not detached");
    (
      options.killProcessGroup ??
      ((pid, nextSignal) => process.kill(pid, nextSignal))
    )(-pid, signal);
    markTreeKilled();
    return;
  }
  if (signal === "SIGKILL") {
    (options.runTaskkill ?? ((args) => Bun.spawnSync(["taskkill", ...args])))([
      "/pid",
      String(pid),
      "/t",
      "/f",
    ]);
    markTreeKilled();
    return;
  }
  throw new Error("unsupported tree termination platform");
}

function sendTerminationSignal(
  proc: ChildProcess,
  signal: TerminationSignal,
  state: TerminationState,
  options: TerminateChildProcessOptions,
): void {
  if (state.settled || childHasExited(proc) || !hasPid(proc)) {
    settleState(state);
    return;
  }
  try {
    state.metadata.terminationSignal = signal;
    sendTreeSignal(proc, signal, state, options);
  } catch (error) {
    try {
      state.metadata.fallbackCause =
        error instanceof Error ? error.message : "tree termination failed";
      sendDirectSignal(proc, signal, state, options);
    } catch {
      settleState(state);
    }
  }
}

export function terminateChildProcess(
  proc: ChildProcess,
  options: TerminateChildProcessOptions = {},
): Promise<TerminationMetadata> {
  const existing = terminationStates.get(proc);
  if (existing) return existing.promise;
  const state = makeState(proc, options);
  terminationStates.set(proc, state);
  if (childHasExited(proc) || !hasPid(proc)) {
    settleState(state);
    return state.promise;
  }
  sendTerminationSignal(proc, "SIGTERM", state, options);
  if (!state.settled) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const setTimer = options.setTimeout ?? setTimeout;
    state.timer = setTimer(() => {
      if (state.settled || childHasExited(proc)) {
        settleState(state);
        return;
      }
      state.metadata.escalated = true;
      sendTerminationSignal(proc, "SIGKILL", state, options);
    }, timeoutMs);
    (state.timer as { unref?: () => void } | undefined)?.unref?.();
  }
  return state.promise;
}
