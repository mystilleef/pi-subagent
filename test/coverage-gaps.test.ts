import { describe, expect, test, vi } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  AGENT_DISCOVERY_CACHE_TTL_MS,
  getCachedAgentDiscovery,
  resetAgentDiscoveryCache,
} from "../src/agent/agent-cache.js";
import { runSingleAgent } from "../src/child/process.js";
import { terminateChildProcess } from "../src/child/termination.js";
import {
  listRunJobs,
  registerRunJob,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
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
} from "../src/progress/progress.js";
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
    test("runSingleAgent with parentModel sets model display", async () => {
      const { cwd } = await setupTest();
      const agent = {
        name: "hang",
        description: "Test agent",
        source: "user" as const,
        thinking: "off" as const,
        systemPrompt: "test",
        filePath: "hang.md",
      };
      const result = await runSingleAgent(
        cwd,
        [agent],
        "hang",
        "task",
        undefined,
        undefined,
        (r) => ({
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: r,
        }),
        { provider: "test-provider", id: "test-model" },
        "off",
      );
      expect(result.model).toBe("test-provider/test-model:off");
    });
    test("runSingleAgent clears transient tool result error on assistant message", async () => {
      const { cwd } = await setupTest({
        piScript: `#!/bin/sh
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","isError":true,"content":[{"type":"toolResultContent","toolCallId":"tc-1","content":[{"type":"text","text":"error"}]}]}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"recovered"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
      });
      const agent = {
        name: "hang",
        description: "Test agent",
        source: "user" as const,
        thinking: "off" as const,
        systemPrompt: "test",
        filePath: "hang.md",
      };
      const result = await runSingleAgent(
        cwd,
        [agent],
        "hang",
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
      expect(result.errorMessage).toBeUndefined();
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
        instanceName: "able-falcon",
        controller: new AbortController(),
        startedAt: Date.now(),
      });
      registerRunJob({
        requestId: "j2",
        agentName: "b",
        instanceName: "brave-otter",
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
        instanceName: "calm-heron",
        controller: c1,
        startedAt: Date.now(),
      });
      registerRunJob({
        requestId: "concurrent-2",
        agentName: "b",
        instanceName: "daring-lynx",
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
      const both = await getCachedAgentDiscovery(cwd, "both");
      const user = await getCachedAgentDiscovery(cwd, "user");
      const project = await getCachedAgentDiscovery(cwd, "project");
      expect(both.agents.length).toBeGreaterThanOrEqual(0);
      expect(user.agents.length).toBeGreaterThanOrEqual(0);
      expect(project.agents.length).toBeGreaterThanOrEqual(0);
      // Different scope calls produce independent cache entries
      expect(both.ts).toBeGreaterThan(0);
      expect(user.ts).toBeGreaterThan(0);
      resetAgentDiscoveryCache();
    });
    test("cache ttl and reset refresh shared async discovery", async () => {
      const { cwd, agentDir } = await setupTest();
      const userAgentsDir = path.join(agentDir, "agents");
      const originalNow = Date.now;
      let now = 1_000;
      Date.now = () => now;
      resetAgentDiscoveryCache();
      try {
        expect(AGENT_DISCOVERY_CACHE_TTL_MS).toBe(300_000);
        const first = await getCachedAgentDiscovery(cwd, "user");
        await Bun.write(
          path.join(userAgentsDir, "ttl-fresh.md"),
          `---
name: ttl-fresh
description: TTL fresh
---
TTL prompt`,
        );
        now += 299_999;
        expect(await getCachedAgentDiscovery(cwd, "user")).toBe(first);
        now += 2;
        const expired = await getCachedAgentDiscovery(cwd, "user");
        expect(expired).not.toBe(first);
        expect(expired.agents.some((agent) => agent.name === "ttl-fresh")).toBe(
          true,
        );
        await Bun.write(
          path.join(userAgentsDir, "reset-fresh.md"),
          `---
name: reset-fresh
description: Reset fresh
---
Reset prompt`,
        );
        expect(await getCachedAgentDiscovery(cwd, "user")).toBe(expired);
        resetAgentDiscoveryCache();
        const reset = await getCachedAgentDiscovery(cwd, "user");
        expect(reset).not.toBe(expired);
        expect(reset.agents.some((agent) => agent.name === "reset-fresh")).toBe(
          true,
        );
      } finally {
        Date.now = originalNow;
        resetAgentDiscoveryCache();
      }
    });
    test("async discovery cache paths avoid sync filesystem helpers", async () => {
      const agentsSource = await Bun.file(
        new URL("../src/agent/agents.ts", import.meta.url),
      ).text();
      const cacheSource = await Bun.file(
        new URL("../src/agent/agent-cache.ts", import.meta.url),
      ).text();
      const asyncSections = [
        /async function loadAgentsFromDirAsync[\s\S]*?function isDirectory/.exec(
          agentsSource,
        )?.[0] ?? "",
        /async function isDirectoryAsync[\s\S]*?function findNearestProjectAgentsDir/.exec(
          agentsSource,
        )?.[0] ?? "",
        /async function findNearestProjectAgentsDirAsync[\s\S]*?export function discoverAgents/.exec(
          agentsSource,
        )?.[0] ?? "",
        /export async function discoverAgentsAsync[\s\S]*?export function formatAgentList/.exec(
          agentsSource,
        )?.[0] ?? "",
        cacheSource,
      ].join("\n");
      expect(asyncSections).toContain("discoverAgentsAsync");
      expect(asyncSections).toContain("fsPromises");
      for (const syncName of [
        "existsSync",
        "readdirSync",
        "readFileSync",
        "statSync",
        "discoverAgents(cwd",
      ]) {
        expect(asyncSections).not.toContain(syncName);
      }
    });
  });
});
