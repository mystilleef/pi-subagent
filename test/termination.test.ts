import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  getProcessTreeSpawnOptions,
  type TerminationSignal,
  terminateChildProcess,
} from "../src/termination.js";

type FakeChild = EventEmitter & {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  signals: TerminationSignal[];
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function makeChild(overrides: Partial<FakeChild> = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 123;
  child.killed = false;
  child.exitCode = null;
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
    const child = makeChild({ pid: undefined });
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
    child.pid = undefined;
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
});
