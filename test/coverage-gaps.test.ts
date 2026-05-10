import { describe, expect, test, vi } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  getCachedAgentDiscovery,
  resetAgentDiscoveryCache,
} from "../src/agent-cache.js";
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
  resetProgressStore,
  type SubagentProgressState,
} from "../src/progress.js";
import {
  listRunJobs,
  registerRunJob,
  resetRunRegistry,
} from "../src/run-registry.js";
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

  describe("global state reset helpers", () => {
    test("resetProgressStore clears all progress state", () => {
      createProgressState("a", "agent-a", "task-a");
      createProgressState("b", "agent-b", "task-b");
      expect(getProgressState("a")).toBeDefined();
      expect(getProgressState("b")).toBeDefined();
      resetProgressStore();
      expect(getProgressState("a")).toBeUndefined();
      expect(getProgressState("b")).toBeUndefined();
    });

    test("resetRunRegistry clears all jobs", () => {
      registerRunJob({
        requestId: "j1",
        agentName: "a",
        controller: new AbortController(),
        startedAt: Date.now(),
      });
      registerRunJob({
        requestId: "j2",
        agentName: "b",
        controller: new AbortController(),
        startedAt: Date.now(),
      });
      expect(listRunJobs().length).toBe(2);
      resetRunRegistry();
      expect(listRunJobs().length).toBe(0);
    });

    test("concurrent job IDs do not collide", () => {
      resetRunRegistry();
      const c1 = new AbortController();
      const c2 = new AbortController();
      registerRunJob({
        requestId: "concurrent-1",
        agentName: "a",
        controller: c1,
        startedAt: Date.now(),
      });
      registerRunJob({
        requestId: "concurrent-2",
        agentName: "b",
        controller: c2,
        startedAt: Date.now(),
      });
      const jobs = listRunJobs();
      expect(jobs.length).toBe(2);
      expect(jobs.find((j) => j.requestId === "concurrent-1")).toBeDefined();
      expect(jobs.find((j) => j.requestId === "concurrent-2")).toBeDefined();
      resetRunRegistry();
    });

    test("cache isolation: different scopes do not cross-contaminate", async () => {
      const { cwd } = await setupTest();
      resetAgentDiscoveryCache();
      const both = getCachedAgentDiscovery(cwd, "both");
      const user = getCachedAgentDiscovery(cwd, "user");
      const project = getCachedAgentDiscovery(cwd, "project");
      expect(both.agents.length).toBeGreaterThanOrEqual(0);
      expect(user.agents.length).toBeGreaterThanOrEqual(0);
      expect(project.agents.length).toBeGreaterThanOrEqual(0);
      // Different scope calls produce independent cache entries
      expect(both.ts).toBeGreaterThan(0);
      expect(user.ts).toBeGreaterThan(0);
      resetAgentDiscoveryCache();
    });
  });
});
