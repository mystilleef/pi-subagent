import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  acquireChildSleepInhibitor,
  getProcessTreeSpawnOptions,
  makeHostSleepInhibitorAdapter,
  type SleepInhibitorAdapter,
  type SleepInhibitorHelperProcess,
  type TerminationSignal,
  terminateChildProcess,
} from "../src/child/termination.js";

type FakeChild = EventEmitter & {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  signals: TerminationSignal[];
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function makeChild(overrides: Partial<FakeChild> = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 123;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal as TerminationSignal);
    return true;
  };
  return Object.assign(child, overrides);
}

function makeTimers() {
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  return {
    timers,
    cleared,
    setTimeout(callback: () => void, _ms?: number) {
      timers.push(callback);
      return callback;
    },
    clearTimeout(timer: unknown) {
      cleared.push(timer);
    },
  };
}

describe("acquireChildSleepInhibitor", () => {
  test("valid finite PIDs acquire one independent release handle", async () => {
    const acquired: number[] = [];
    const released: number[] = [];
    const adapter: SleepInhibitorAdapter = {
      acquire(pid) {
        acquired.push(pid);
        return {
          release() {
            released.push(pid);
          },
        };
      },
    };
    const first = await acquireChildSleepInhibitor(101, adapter);
    const second = await acquireChildSleepInhibitor(202, adapter);
    await first.release();
    await second.release();
    expect(acquired).toEqual([101, 202]);
    expect(released).toEqual([101, 202]);
  });
  test("invalid and missing PIDs return no-op handles without acquisition", async () => {
    const acquired: unknown[] = [];
    const adapter: SleepInhibitorAdapter = {
      acquire(pid) {
        acquired.push(pid);
      },
    };
    const missing = await acquireChildSleepInhibitor(undefined, adapter);
    const infinite = await acquireChildSleepInhibitor(Infinity, adapter);
    const nonNumeric = await acquireChildSleepInhibitor("123", adapter);
    await missing.release();
    await infinite.release();
    await nonNumeric.release();
    expect(acquired).toEqual([]);
  });
  test("unsupported and failed acquisition degrade to no-op handles", async () => {
    const unsupported = await acquireChildSleepInhibitor(303, {
      supported() {
        return false;
      },
      acquire() {
        throw new Error("must not acquire");
      },
    });
    const failed = await acquireChildSleepInhibitor(404, {
      acquire() {
        throw new Error("helper unavailable");
      },
    });
    await unsupported.release();
    await failed.release();
  });
  test("repeated release and release failures stay silent", async () => {
    let releaseCalls = 0;
    const handle = await acquireChildSleepInhibitor(505, {
      acquire() {
        return {
          release() {
            releaseCalls += 1;
            throw new Error("already ended");
          },
        };
      },
    });
    await handle.release();
    await handle.release();
    expect(releaseCalls).toBe(1);
  });
});

describe("makeHostSleepInhibitorAdapter", () => {
  test("supported hosts spawn a silent detached helper scoped to the child PID", async () => {
    const helper = {
      exitCode: null,
      signalCode: null,
      killSignals: [] as Array<NodeJS.Signals | number | undefined>,
      unrefCalls: 0,
      kill(signal?: NodeJS.Signals | number) {
        helper.killSignals.push(signal);
        return true;
      },
      unref() {
        helper.unrefCalls += 1;
      },
    };
    const spawned: Array<{
      command: string;
      args: string[];
      options: { stdio: "ignore"; detached: true };
    }> = [];
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists(command) {
        return command === "/usr/bin/caffeinate";
      },
      spawnHelper(command, args, options) {
        spawned.push({ command, args, options });
        return helper;
      },
    });
    const handle = await acquireChildSleepInhibitor(606, adapter);
    await handle.release();
    expect(spawned).toEqual([
      {
        command: "/usr/bin/caffeinate",
        args: ["-dimsu", "-w", "606"],
        options: { stdio: "ignore", detached: true },
      },
    ]);
    expect(helper.unrefCalls).toBe(1);
    expect(helper.killSignals).toEqual(["SIGTERM"]);
  });
  test("unsupported hosts and missing helper capability stay no-op", async () => {
    const spawned: string[] = [];
    const unsupported = makeHostSleepInhibitorAdapter({
      platform: "linux",
      async commandExists() {
        return true;
      },
      spawnHelper(command) {
        spawned.push(command);
        throw new Error("must not spawn");
      },
    });
    const missingCapability = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return false;
      },
      spawnHelper(command) {
        spawned.push(command);
        throw new Error("must not spawn");
      },
    });
    await (await acquireChildSleepInhibitor(707, unsupported)).release();
    await (await acquireChildSleepInhibitor(808, missingCapability)).release();
    expect(spawned).toEqual([]);
  });
  test("adapter without supported method delegates directly to acquire", async () => {
    const acquired: number[] = [];
    const adapter = {
      acquire(pid: number) {
        acquired.push(pid);
        return { release() {} };
      },
    } as unknown as SleepInhibitorAdapter;
    const handle = await acquireChildSleepInhibitor(111, adapter);
    await handle.release();
    expect(acquired).toEqual([111]);
  });
  test("helper with no kill method handles release gracefully", async () => {
    const adapter = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        return {
          exitCode: null,
          signalCode: null,
          unref() {},
        } as unknown as SleepInhibitorHelperProcess;
      },
    });
    const handle = await acquireChildSleepInhibitor(222, adapter);
    await handle.release();
  });
  test("startup, async helper errors, release, and already-ended helpers degrade silently", async () => {
    const startupFailure = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        throw new Error("spawn failed");
      },
    });
    const releaseFailure = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        return {
          exitCode: null,
          signalCode: null,
          unref() {},
          kill() {
            throw new Error("release failed");
          },
        };
      },
    });
    let emittedHelper: EventEmitter | undefined;
    const asyncHelperError = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        const helper = new EventEmitter() as EventEmitter & {
          exitCode: null;
          signalCode: null;
          unref: () => void;
          kill: () => void;
        };
        helper.exitCode = null;
        helper.signalCode = null;
        helper.unref = () => {};
        helper.kill = () => {};
        emittedHelper = helper;
        return helper;
      },
    });
    const alreadyEnded = makeHostSleepInhibitorAdapter({
      platform: "darwin",
      async commandExists() {
        return true;
      },
      spawnHelper() {
        return {
          exitCode: 0,
          signalCode: null,
          unref() {},
          kill() {
            throw new Error("must not kill ended helper");
          },
        };
      },
    });
    await (await acquireChildSleepInhibitor(909, startupFailure)).release();
    await (await acquireChildSleepInhibitor(1001, releaseFailure)).release();
    const asyncHandle = await acquireChildSleepInhibitor(
      1002,
      asyncHelperError,
    );
    expect(() =>
      emittedHelper?.emit("error", new Error("helper failed")),
    ).not.toThrow();
    await asyncHandle.release();
    await (await acquireChildSleepInhibitor(1003, alreadyEnded)).release();
  });
});

describe("getProcessTreeSpawnOptions", () => {
  test("detaches only POSIX tree spawns", () => {
    expect(getProcessTreeSpawnOptions(true, "linux")).toEqual({
      detached: true,
    });
    expect(getProcessTreeSpawnOptions(true, "win32")).toEqual({});
    expect(getProcessTreeSpawnOptions(false, "linux")).toEqual({});
  });
});

describe("terminateChildProcess", () => {
  test("sends SIGTERM before SIGKILL", async () => {
    const child = makeChild();
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("exit", null, "SIGKILL");
    const metadata = await promise;
    expect(metadata.escalated).toBe(true);
    expect(metadata.terminationSignal).toBe("SIGKILL");
  });
  test("escalates after requested timeout", () => {
    const child = makeChild();
    let timeout = 0;
    const timers = makeTimers();
    void terminateChildProcess(child as unknown as ChildProcess, {
      timeoutMs: 12,
      setTimeout(callback, ms) {
        timeout = ms;
        return timers.setTimeout(callback, ms);
      },
    });
    expect(timeout).toBe(12);
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
  test("keeps pending child cancellable after SIGTERM marks it killed", () => {
    const child = makeChild();
    child.kill = (signal) => {
      child.killed = true;
      child.signals.push(signal as TerminationSignal);
      return true;
    };
    const timers = makeTimers();
    void terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
    });
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
  test("repeated calls reuse state and do not re-arm timers", () => {
    const child = makeChild();
    const timers = makeTimers();
    const first = terminateChildProcess(child as unknown as ChildProcess, {
      reason: "first",
      setTimeout: timers.setTimeout,
    });
    const second = terminateChildProcess(child as unknown as ChildProcess, {
      reason: "second",
      setTimeout: timers.setTimeout,
    });
    expect(first).toBe(second);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(timers.timers).toHaveLength(1);
  });
  test("already-exited child settles without signals", async () => {
    const child = makeChild({ exitCode: 0 });
    const metadata = await terminateChildProcess(
      child as unknown as ChildProcess,
    );
    expect(child.signals).toEqual([]);
    expect(metadata.terminationSignal).toBeUndefined();
  });
  test("missing PID settles without signals", async () => {
    const child = makeChild();
    delete child.pid;
    const metadata = await terminateChildProcess(
      child as unknown as ChildProcess,
    );
    expect(child.signals).toEqual([]);
    expect(metadata.terminationSignal).toBeUndefined();
  });
  test("cleans timer when child exits", async () => {
    const child = makeChild();
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    child.emit("close", 0, null);
    await promise;
    expect(timers.cleared).toHaveLength(1);
  });
  test("signals POSIX detached process group with negative PID", () => {
    const child = makeChild({ pid: 456 });
    const targets: Array<[number, TerminationSignal]> = [];
    void terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      processTreeDetached: true,
      killProcessGroup(pid, signal) {
        targets.push([pid, signal]);
      },
    });
    expect(targets).toEqual([[-456, "SIGTERM"]]);
    expect(child.signals).toEqual([]);
  });
  test("falls back to direct signal when POSIX tree lacks detached group", () => {
    const child = makeChild({ pid: 789 });
    void terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
    });
    expect(child.signals).toEqual(["SIGTERM"]);
  });
  test("settles when tree fallback direct signal fails", async () => {
    const child = makeChild({ pid: 790 });
    const metadata = await terminateChildProcess(
      child as unknown as ChildProcess,
      {
        tree: true,
        platform: "linux",
        killProcess() {
          throw new Error("direct kill failed");
        },
      },
    );
    expect(metadata.fallbackCause).toBe("process tree not detached");
    expect(metadata.target).toBe("tree");
  });
  test("runs Windows taskkill command during forceful tree escalation", () => {
    const child = makeChild({ pid: 321 });
    const timers = makeTimers();
    const taskkillArgs: string[][] = [];
    void terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "win32",
      setTimeout: timers.setTimeout,
      runTaskkill(args) {
        taskkillArgs.push(args);
      },
    });
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(taskkillArgs).toEqual([["/pid", "321", "/t", "/f"]]);
  });
  test("uses injected process tree killer before scheduling escalation", async () => {
    const child = makeChild({ pid: 432 });
    const killed: Array<{
      platform: NodeJS.Platform;
      signal: TerminationSignal;
    }> = [];
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      killProcessTree(_child, signal, platform) {
        killed.push({ platform, signal });
      },
    });
    child.emit("exit");
    const metadata = await promise;
    expect(killed).toEqual([{ platform: "linux", signal: "SIGTERM" }]);
    expect(metadata.target).toBe("tree");
    expect(metadata.processTreeKilled).toBe(true);
  });
  test("settles escalation when PID disappears before timeout", async () => {
    const child = makeChild({ pid: 876 });
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
    });
    delete child.pid;
    timers.timers[0]?.();
    const metadata = await promise;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(metadata.escalated).toBe(true);
  });
  test("settles when child exits before timeout escalation", async () => {
    const child = makeChild({ pid: 987 });
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
    });
    child.exitCode = 0;
    timers.timers[0]?.();
    const metadata = await promise;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(metadata.escalated).toBe(false);
  });
  test("falls back to direct signal when Windows taskkill fails", () => {
    const child = makeChild({ pid: 654 });
    const timers = makeTimers();
    void terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "win32",
      setTimeout: timers.setTimeout,
      runTaskkill() {
        throw new Error("taskkill failed");
      },
    });
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
  test("win32 SIGTERM tree falls back to direct signal", async () => {
    const child = makeChild({ pid: 555 });
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "win32",
    });
    child.emit("exit");
    const metadata = await promise;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(metadata.fallbackCause).toBe(
      "unsupported tree termination platform",
    );
    expect(metadata.target).toBe("direct");
  });
  test("settles via signalCode when exitCode is null", async () => {
    const child = makeChild();
    child.signalCode = "SIGTERM";
    const metadata = await terminateChildProcess(
      child as unknown as ChildProcess,
    );
    expect(child.signals).toEqual([]);
    expect(metadata.terminationSignal).toBeUndefined();
  });
  test("error event settles the termination state", async () => {
    const child = makeChild();
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    child.emit("error", new Error("spawn failed"));
    const metadata = await promise;
    expect(metadata.escalated).toBe(false);
    expect(timers.cleared).toHaveLength(1);
  });
  test("double settle is idempotent", async () => {
    const child = makeChild();
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    const metadata = await promise;
    expect(metadata.escalated).toBe(false);
  });
  test("timer unrefs when handle supports it", () => {
    const child = makeChild();
    const unrefed: unknown[] = [];
    const fakeTimer = {
      unref() {
        unrefed.push(true);
      },
    };
    void terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout() {
        return fakeTimer;
      },
    });
    expect(unrefed).toHaveLength(1);
  });
  test("tolerates timer handle without unref method", () => {
    const child = makeChild();
    const plainTimer = Symbol("timer");
    void terminateChildProcess(child as unknown as ChildProcess, {
      setTimeout() {
        return plainTimer;
      },
    });
  });
  test("uses default killProcessGroup for POSIX detached tree", async () => {
    const child = makeChild({ pid: 99999 });
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      processTreeDetached: true,
      setTimeout: timers.setTimeout,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.fallbackCause).toBeDefined();
    expect(metadata.target).toBe("direct");
  });
  test("uses default runTaskkill for Windows SIGKILL tree escalation", async () => {
    const child = makeChild({ pid: 99999 });
    const timers = makeTimers();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "win32",
      setTimeout: timers.setTimeout,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    timers.timers[0]?.();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.escalated).toBe(true);
    expect(metadata.fallbackCause).toBeDefined();
  });
  test("falls back to direct when injected killProcessTree throws", async () => {
    const child = makeChild({ pid: 444 });
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      killProcessTree() {
        throw new Error("tree killer failed");
      },
    });
    child.emit("exit");
    const metadata = await promise;
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(metadata.fallbackCause).toBe("tree killer failed");
    expect(metadata.target).toBe("direct");
  });
  test("uses default fallbackCause for non-Error tree kill failures", async () => {
    const child = makeChild({ pid: 556 });
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: true,
      platform: "linux",
      killProcessTree() {
        throw "string error";
      },
    });
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.fallbackCause).toBe("tree termination failed");
    expect(metadata.target).toBe("direct");
  });
  test("populates cancelRequestedAt and cancelReason in metadata", async () => {
    const child = makeChild();
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      reason: "user requested",
      now: () => 42,
    });
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.cancelRequestedAt).toBe(42);
    expect(metadata.cancelReason).toBe("user requested");
    expect(metadata.target).toBe("direct");
    expect(metadata.escalated).toBe(false);
    expect(metadata.processTreeKilled).toBe(false);
  });
  test("direct termination with explicit tree false and kill injection", async () => {
    const child = makeChild({ pid: 111 });
    const killed: TerminationSignal[] = [];
    const promise = terminateChildProcess(child as unknown as ChildProcess, {
      tree: false,
      platform: "linux",
      reason: "explicit",
      killProcess(_proc, signal) {
        killed.push(signal);
      },
    });
    expect(killed).toEqual(["SIGTERM"]);
    child.emit("exit");
    const metadata = await promise;
    expect(metadata.target).toBe("direct");
    expect(metadata.processTreeKilled).toBe(false);
    expect(metadata.cancelReason).toBe("explicit");
  });
});
