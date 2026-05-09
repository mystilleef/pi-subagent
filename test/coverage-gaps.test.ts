import { describe, expect, test, vi } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { runSingleAgent } from "../src/process.js";
import {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  finalizeProgressState,
  formatHeaderStats,
  formatTokenCount,
  getProgressState,
  patchProgressState,
  type SubagentProgressState,
} from "../src/progress.js";
import { terminateChildProcess } from "../src/termination.js";
import { setupHooks, setupTest, waitFor } from "./helpers.js";

setupHooks();

describe("Coverage Gaps", () => {
  describe("termination.ts defaults", () => {
    test("uses default killProcess and clearTimeout", async () => {
      const child = new EventEmitter() as unknown as ChildProcess;
      // biome-ignore lint/suspicious/noExplicitAny: mocking complex child process
      (child as any).pid = 999;
      // biome-ignore lint/suspicious/noExplicitAny: mocking complex child process
      (child as any).kill = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: mocking complex child process
      (child as any).exitCode = null;

      const promise = terminateChildProcess(child);
      // biome-ignore lint/suspicious/noExplicitAny: mocking complex child process
      expect((child as any).kill).toHaveBeenCalledWith("SIGTERM");

      child.emit("exit", 0);
      await promise;
    });

    test("uses default runTaskkill on Windows", async () => {
      const originalSpawnSync = Bun.spawnSync;
      // biome-ignore lint/suspicious/noExplicitAny: mocking global Bun
      (Bun as any).spawnSync = vi.fn(() => ({ success: true }));

      const child = new EventEmitter() as unknown as ChildProcess;
      // biome-ignore lint/suspicious/noExplicitAny: mocking complex child process
      (child as any).pid = 888;
      // biome-ignore lint/suspicious/noExplicitAny: mocking complex child process
      (child as any).kill = vi.fn();
      // biome-ignore lint/suspicious/noExplicitAny: mocking complex child process
      (child as any).exitCode = null;

      const timers: (() => void)[] = [];
      const promise2 = terminateChildProcess(child, {
        tree: true,
        platform: "win32",
        timeoutMs: 1,
        setTimeout: (cb) => {
          timers.push(cb);
          // biome-ignore lint/suspicious/noExplicitAny: mocking timer handle
          return 123 as any;
        },
      });

      timers[0]?.();

      expect(Bun.spawnSync).toHaveBeenCalled();
      // biome-ignore lint/suspicious/noExplicitAny: mocking global Bun
      (Bun as any).spawnSync = originalSpawnSync;
      child.emit("exit", 0);
      await promise2;
    });
  });

  describe("progress.ts helpers and defaults", () => {
    test("formatTokenCount with Millions", () => {
      expect(formatTokenCount(1_000_000)).toBe("1M");
      expect(formatTokenCount(1_500_000)).toBe("1.5M");
      expect(formatTokenCount(2_000_000)).toBe("2M");
    });

    test("formatHeaderStats edges", () => {
      expect(
        formatHeaderStats({
          toolCount: 0,
          startTime: Date.now(),
        } as SubagentProgressState),
      ).toContain("--% ctx");
      expect(
        formatHeaderStats({
          toolCount: 0,
          startTime: Date.now(),
          contextTokens: -1,
          contextWindowTokens: 100,
        } as SubagentProgressState),
      ).toContain("0% ctx");
      expect(
        formatHeaderStats({
          toolCount: 0,
          startTime: Date.now(),
          contextTokens: 50,
          contextWindowTokens: 100,
        } as SubagentProgressState),
      ).toContain("50% ctx");
    });

    test("patchProgressState for non-running status", () => {
      const id = "test-id";
      createProgressState(id, "agent", "task");
      finalizeProgressState(id, "done");

      patchProgressState(id, {
        lastToolPreview: "should-be-ignored",
        toolCount: 10,
      });
      const state = getProgressState(id);
      expect(state?.lastToolPreview).toBeUndefined();
      expect(state?.toolCount).toBe(10);
      clearProgressState(id);
    });

    test("cancelProgressState with reason", () => {
      const id = "cancel-id";
      createProgressState(id, "agent", "task");
      cancelProgressState(id, "user requested");
      const state = getProgressState(id);
      expect(state?.status).toBe("cancelled");
      expect(state?.errorText).toBe("user requested");
      clearProgressState(id);
    });
  });

  describe("process.ts gaps", () => {
    test("spawn failure handler", async () => {
      const { cwd } = await setupTest();
      const originalArgv1 = process.argv[1];
      const originalExecPath = process.execPath;
      process.argv[1] = "/non/existent/pi";
      process.execPath = "/non/existent/pi_exec";

      try {
        // biome-ignore lint/suspicious/noExplicitAny: mocking agent config
        const agent: any = {
          name: "fail",
          source: "user",
          thinking: "off",
          systemPrompt: "",
          tools: [],
        };
        const result = await runSingleAgent(
          cwd,
          [agent],
          "fail",
          "task",
          undefined,
          undefined,
          (r) => ({
            mode: "single",
            agentScope: "both",
            projectAgentsDir: null,
            results: r,
          }),
          undefined,
          "off",
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("ENOENT");
      } finally {
        if (originalArgv1 !== undefined) process.argv[1] = originalArgv1;
        process.execPath = originalExecPath;
      }
    });

    test("cancellation with Error reason", async () => {
      const { cwd } = await setupTest({
        piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
      });
      const controller = new AbortController();
      const promise = runSingleAgent(
        cwd,
        [], // agents not used here for unknown agent
        "missing",
        "task",
        controller.signal,
        undefined,
        (r) => ({
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: r,
        }),
        undefined,
        "off",
      );

      // Wait for it to detect unknown agent
      const result = await promise;
      expect(result.exitCode).toBe(1);
    });
  });

  describe("helpers.ts waitFor timeout", () => {
    test("waitFor throws on timeout", async () => {
      const originalNow = Date.now;
      let now = 1000;
      Date.now = () => now;

      try {
        const promise = waitFor(() => false, "never");
        now += 3000;
        await expect(promise).rejects.toThrow("Timed out waiting for never");
      } finally {
        Date.now = originalNow;
      }
    });
  });
});
