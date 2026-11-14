import { describe, expect, spyOn, test } from "bun:test";
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getCachedAgentCompletions,
  getCachedAgentDiscovery,
  resetAgentDiscoveryCache,
} from "../src/agent/agent-cache.js";
import { resetAgentCache } from "../src/index.js";
import { listRunJobs } from "../src/orchestration/run-registry.js";
import * as usageLedger from "../src/orchestration/usage-ledger.js";
import {
  queryInstanceUsage,
  queryRootRunUsage,
  querySessionUsage,
} from "../src/orchestration/usage-ledger.js";
import type { UsageInstanceNode } from "../src/shared/types.js";
import {
  emitSessionShutdown,
  emitSessionStart,
  makeBareCtx,
  type RegisteredEventHandler,
  runTool,
  setupFakePi,
  setupHooks,
  setupTest,
  waitForRunJobCount,
  waitForRunJobsCleared,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

/**
 * Event-driven completion signal for fire-and-forget root runs: resolves when
 * the lifecycle sends its terminal result message.
 */
function trackResultMessage(): {
  sendMessage: (msg: import("./helpers.js").SendMessageArg) => void;
  resultMessage: Promise<import("./helpers.js").SendMessageArg>;
} {
  const deferred: {
    resolve?: (msg: import("./helpers.js").SendMessageArg) => void;
  } = {};
  const resultMessage = new Promise<import("./helpers.js").SendMessageArg>(
    (resolve) => {
      deferred.resolve = resolve;
    },
  );
  return {
    sendMessage: (msg) => {
      if (msg.customType === "subagent-result") deferred.resolve?.(msg);
    },
    resultMessage,
  };
}

async function emitResourcesDiscover(
  tool: { registeredEventHandlers: Map<string, RegisteredEventHandler[]> },
  ctxCwd: string | undefined,
  eventCwd: string | undefined,
) {
  for (const handler of tool.registeredEventHandlers.get(
    "resources_discover",
  ) ?? []) {
    await handler({ type: "resources_discover", cwd: eventCwd }, {
      cwd: ctxCwd,
    } as ExtensionCommandContext);
  }
}

describe("index.ts", () => {
  describe("resetAgentCache", () => {
    test("delegates to resetAgentDiscoveryCache", async () => {
      const { cwd } = await setupFakePi();
      await getCachedAgentCompletions("", cwd);
      const cached = await getCachedAgentDiscovery(cwd, "both");
      expect(await getCachedAgentDiscovery(cwd, "both")).toBe(cached);
      resetAgentCache();
      expect(await getCachedAgentDiscovery(cwd, "both")).not.toBe(cached);
      resetAgentDiscoveryCache();
    });
  });

  describe("normalizeWorkspaceRoot via event handlers", () => {
    test("session_start with undefined ctx.cwd clears workspace root", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
    });

    test.each([
      {
        name: "session_start with empty string ctx.cwd clears workspace root",
        cwd: "",
      },
      {
        name: "session_start with whitespace-only ctx.cwd clears workspace root",
        cwd: "   ",
      },
    ])("$name", async (row) => {
      const { tool } = await setupTest();
      await emitSessionStart(tool, row.cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toEqual([]);
    });

    test("session_start trims valid cwd", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, `  ${cwd}  `);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions?.length).toBeGreaterThanOrEqual(0);
    });

    test("resources_discover uses ctx.cwd when event.cwd is undefined", async () => {
      const { tool, cwd } = await setupTest();
      await emitResourcesDiscover(tool, cwd, undefined);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
    });

    test("resources_discover falls back to event.cwd when ctx.cwd is undefined", async () => {
      const { tool, cwd } = await setupTest();
      await emitResourcesDiscover(tool, undefined, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
    });

    test("resources_discover with both undefined clears workspace root", async () => {
      const { tool } = await setupTest();
      await emitResourcesDiscover(tool, undefined, undefined);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toEqual([]);
    });

    test("resources_discover prefers ctx.cwd over event.cwd when both defined", async () => {
      const { tool, cwd } = await setupTest();
      await emitResourcesDiscover(tool, cwd, "/some/other/path");
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
    });

    test("subsequent events override workspace root", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completionsBefore =
        await runCommand?.getArgumentCompletions?.("hang");
      await emitSessionStart(tool, "/nonexistent/override");
      const completionsAfter =
        await runCommand?.getArgumentCompletions?.("hang");
      expect(completionsBefore).toBeDefined();
      expect(completionsAfter).toEqual([]);
    });
  });

  describe("getRunArgumentCompletions", () => {
    test("returns empty when no workspace root set", async () => {
      const { tool } = await setupTest();
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toEqual([]);
    });

    test("returns empty when workspace root is not a directory", async () => {
      const { tool } = await setupTest();
      await emitSessionStart(tool, "/nonexistent/path/that/does/not/exist");
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toEqual([]);
    });

    test("returns filtered completions with valid prefix", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("ha");
      expect(completions).toBeDefined();
      if (completions && completions.length > 0) {
        for (const c of completions) {
          expect(c.value).toStartWith("ha");
          expect(c.label).toStartWith("ha");
        }
      }
    });

    test("returns empty for non-matching prefix", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completions =
        await runCommand?.getArgumentCompletions?.("zzz_nonexistent");
      expect(completions).toEqual([]);
    });
  });

  describe("registered renderers", () => {
    test.each([
      {
        name: "registers subagent-progress message renderer",
        rendererType: "subagent-progress",
      },
      {
        name: "registers subagent-result message renderer",
        rendererType: "subagent-result",
      },
    ])("$name", async (row) => {
      const { tool } = await setupTest();
      expect(
        tool.registeredMessageRenderers.get(row.rendererType),
      ).toBeDefined();
    });
  });

  describe("command descriptions", () => {
    test.each([
      ["run", "Run a subagent directly: /run <agent> [task]"],
      [
        "cancel-subagent",
        "Cancel active /run subagents: /cancel-subagent [requestId|all]",
      ],
      ["jobs", "List all /run jobs and their statuses: /jobs"],
      [
        "stats",
        "Show subagent usage statistics: /stats [requestId|instanceName]",
      ],
    ])("%s command has correct description", async (name, description) => {
      const { tool } = await setupTest();
      expect(tool.registeredCommands.get(name)?.description).toBe(description);
    });
  });

  describe("stats command handler", () => {
    test("notifies session and run stats through registered stats command without mutating state", async () => {
      const { tool, cwd } = await setupTest();
      const statsCommand = tool.registeredCommands.get("stats");
      expect(statsCommand).toBeDefined();

      const notices: string[] = [];
      const boardWidth = 300;
      const ctx = {
        ...makeBareCtx(cwd),
        ui: {
          notify: (msg: string) => notices.push(msg),
          select: async () => undefined,
          custom: async (
            factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0],
          ) => {
            let result = "";
            const theme = {
              fg: (_color: unknown, text: string): string => text,
              bg: (_color: unknown, text: string): string => text,
              bold: (text: string): string => text,
              italic: (text: string): string => text,
            };
            const component = await factory(
              undefined as never,
              theme as never,
              undefined as never,
              (value) => {
                result = value as string;
              },
            );
            component.render(boardWidth);
            return result;
          },
        },
        sessionManager: {
          getEntries: () => [
            {
              type: "custom",
              customType: "subagent-usage",
              data: {
                v: 1,
                run: {
                  id: "cmd-run-1",
                  agent: "worker",
                  instanceName: "swift-fox",
                  ordinal: 1,
                  startedAt: 1_000,
                  status: "success",
                  durationMs: 1_200,
                  usage: {
                    input: 40,
                    output: 15,
                    cacheRead: 5,
                    cacheWrite: 0,
                    cost: 0.012,
                    turns: 2,
                  },
                  children: [],
                },
              },
            },
          ],
          getBranch: () => [],
        },
      } as unknown as ExtensionCommandContext;

      await emitSessionStart(tool, cwd, { reason: "resume", ctx });
      const before = querySessionUsage();

      await statsCommand?.handler?.("", ctx);
      await statsCommand?.handler?.("swift-fox", ctx);
      await statsCommand?.handler?.("unknown-run", ctx);

      expect(notices).toHaveLength(3);
      const sessionBoard = notices[0] ?? "";
      expect(sessionBoard).toContain("Session");
      expect(sessionBoard).toContain("1 run");
      expect(sessionBoard).toContain("1 instance");
      expect(sessionBoard).toContain("↑40");
      expect(sessionBoard).toContain("↓15");
      expect(sessionBoard).toContain("R5");
      expect(sessionBoard).toContain("$0.0120");
      expect(sessionBoard).toContain("worker");
      expect(sessionBoard).toContain("✓1");
      expect(sessionBoard).toContain("1.2s");
      expect(sessionBoard).toContain("swift-fox");
      expect(sessionBoard).toContain("RUNS (1)");
      // R-011: notifications render at board width minus two columns.
      const notifyWidth = boardWidth - 2;
      expect(notices[1]).toBe(
        [
          "swift-fox (cmd-run-1) · 1 instance · ✓1 ✗0 ⊘0 ⟳0 · ↑40 ↓15 R5 · $0.0120 · 1.2s",
          "✓ worker #1 swift-fox · 1.2s · $0.0120",
        ]
          .map((line) => line.padEnd(notifyWidth))
          .join("\n"),
      );
      expect(notices[2]).toBe('No run matches "unknown-run".');
      expect(querySessionUsage()).toEqual(before);
    });
  });

  describe("registered tool", () => {
    test("tool has correct name and description", async () => {
      const { tool } = await setupTest();
      expect(tool.name).toBe("subagent");
      expect(tool.description).toBe(
        "Delegate a task to a subagent with isolated context.",
      );
    });

    test("tool has correct label", async () => {
      const { tool } = await setupTest();
      expect(tool.label).toBe("Subagent");
    });

    test("tool has SubagentParams schema", async () => {
      const { tool } = await setupTest();
      expect(tool.parameters).toBeDefined();
    });
  });

  describe("run command handler", () => {
    test("notifies usage when no args provided", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest({
        sendMessage: () => {},
      });
      const ctx = {
        cwd: "/tmp",
        signal: AbortSignal.timeout(5000),
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const runCommand = tool.registeredCommands.get("run");
      await runCommand?.handler?.("", ctx);
      expect(notifications[0]).toBe("Usage: /run <agent> [task]");
    });

    test("updates workspace root from ctx.cwd before processing", async () => {
      const { tool, cwd } = await setupTest();
      const runCommand = tool.registeredCommands.get("run");
      const ctx = {
        cwd,
        signal: AbortSignal.timeout(30000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      await runCommand?.handler?.("hang hello", ctx);
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
      await waitForRunJobsCleared();
    });

    test("notifies usage when args are whitespace", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      const ctx = {
        cwd: "/tmp",
        signal: AbortSignal.timeout(5000),
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const runCommand = tool.registeredCommands.get("run");
      await runCommand?.handler?.("   ", ctx);
      expect(notifications[0]).toBe("Usage: /run <agent> [task]");
    });

    test("notifies unknown agent when agent not found", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      const ctx = {
        cwd: "/tmp",
        signal: AbortSignal.timeout(5000),
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const runCommand = tool.registeredCommands.get("run");
      await runCommand?.handler?.("nonexistent-agent", ctx);
      expect(notifications.some((n) => n.includes("Unknown agent"))).toBe(true);
    });
  });

  describe("cancel-subagent command handler", () => {
    test.each([
      {
        name: "notifies no active jobs when no jobs running and args empty",
        args: "",
        expectedNotification: "No active /run jobs.",
      },
      {
        name: "notifies no active jobs when target 'all' and no jobs running",
        args: "all",
        expectedNotification: "No active /run jobs.",
      },
      {
        name: "notifies no active job when specific requestId not found",
        args: "nonexistent-id",
        expectedNotification: "No active /run job nonexistent-id.",
      },
    ])("$name", async (row) => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      const ctx = {
        cwd: "/tmp",
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
        },
      } as unknown as ExtensionCommandContext;
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      await cancelCommand?.handler?.(row.args, ctx);
      expect(notifications[0]).toBe(row.expectedNotification);
    });

    test("presents selection UI when jobs are active and no args", async () => {
      const sentMessages: import("./helpers.js").SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      const runCommand = tool.registeredCommands.get("run");
      const runCtx = {
        cwd,
        signal: AbortSignal.timeout(30000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      await runCommand?.handler?.("hang hello", runCtx);
      await waitForRunJobCount(1);
      const selections: string[][] = [];
      const cancelCtx = {
        cwd,
        ui: {
          notify: () => {},
          select: async (_title: string, options: string[]) => {
            selections.push(options);
            return undefined;
          },
        },
      } as unknown as ExtensionCommandContext;
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      await cancelCommand?.handler?.("", cancelCtx);
      expect(selections.length).toBe(1);
      expect(
        selections[0]?.some((o) => o.includes("All running subagents")),
      ).toBe(true);
      await waitForRunJobsCleared();
    });

    test("cancels specific job when requestId matches active job", async () => {
      const notifications: string[] = [];
      const sentMessages: import("./helpers.js").SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      const runCommand = tool.registeredCommands.get("run");
      const runCtx = {
        cwd,
        signal: AbortSignal.timeout(30000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      await runCommand?.handler?.("hang hello", runCtx);
      await waitForRunJobCount(1);
      const jobs = listRunJobs();
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      const requestId = jobs[0]?.requestId ?? "";
      const cancelCtx = {
        cwd,
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
        },
      } as unknown as ExtensionCommandContext;
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      await cancelCommand?.handler?.(requestId, cancelCtx);
      expect(notifications[0]).toBe(`Cancelled /run job ${requestId}.`);
      await waitForRunJobsCleared();
    });
  });

  describe("jobs command handler", () => {
    test("invokes jobs handler without error", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      let customCalled = false;
      const ctx = {
        cwd: "/tmp",
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
          custom: async () => {
            customCalled = true;
            return "rendered";
          },
        },
      } as unknown as ExtensionCommandContext;
      const jobsCommand = tool.registeredCommands.get("jobs");
      await jobsCommand?.handler?.("", ctx);
      const hitNoJobs = notifications.includes("No /run jobs in this session.");
      const hitCustom = customCalled;
      expect(hitNoJobs || hitCustom).toBe(true);
    });
  });

  describe("tool execute", () => {
    test("returns formatted result for successful run", async () => {
      const sentMessages: import("./helpers.js").SendMessageArg[] = [];
      const tracker = trackResultMessage();
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => {
          sentMessages.push(msg);
          tracker.sendMessage(msg);
        },
      });
      const ctx = {
        cwd,
        signal: AbortSignal.timeout(30000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const result = await tool.execute(
        "call-1",
        { agent: "hang", task: "test task" },
        AbortSignal.timeout(30000),
        () => {},
        ctx,
      );
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.details).toBeDefined();
      expect(result.details.mode).toBe("single");
      await tracker.resultMessage;
    });

    test("returns not_found result for unknown agent", async () => {
      const { tool, cwd } = await setupTest();
      const ctx = {
        cwd,
        signal: AbortSignal.timeout(10000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const result = await tool.execute(
        "call-2",
        { agent: "nonexistent" },
        AbortSignal.timeout(10000),
        () => {},
        ctx,
      );
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    test("renderCall returns content", async () => {
      const { tool } = await setupTest();
      const rendered = tool.renderCall(
        { agent: "hang", task: "test" },
        {
          fg: (_c: string, t: string) => t,
          bg: (_c: string, t: string) => t,
          bold: (t: string) => t,
          italic: (t: string) => t,
        } as unknown as import("@earendil-works/pi-coding-agent").Theme,
        undefined as never,
      );
      expect(rendered).toBeDefined();
    });

    test.each([
      {
        name: "renderResult returns content",
        contentText: "done",
        finalOutput: "done",
        displayMode: "inline",
      },
      {
        name: "renderResult with block display mode",
        contentText: "block output",
        finalOutput: "block output",
        displayMode: "block",
      },
    ])("$name", async (row) => {
      const { tool } = await setupTest();
      const mockResult = {
        content: [{ type: "text" as const, text: row.contentText }],
        details: {
          mode: "single" as const,
          agentScope: "both" as const,
          projectAgentsDir: null,
          results: [
            {
              agent: "hang",
              task: "test",
              exitCode: 0,
              finalOutput: row.finalOutput,
              stderr: "",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 1,
              },
              agentSource: "user" as const,
            },
          ],
        },
      };
      const rendered = tool.renderResult(
        mockResult as never,
        row.displayMode as never,
        {
          fg: (_c: string, t: string) => t,
          bg: (_c: string, t: string) => t,
          bold: (t: string) => t,
          italic: (t: string) => t,
        } as unknown as import("@earendil-works/pi-coding-agent").Theme,
        undefined as never,
      );
      expect(rendered).toBeDefined();
    });

    test("execute with undefined signal and onUpdate", async () => {
      const tracker = trackResultMessage();
      const { tool, cwd } = await setupTest({
        sendMessage: tracker.sendMessage,
      });
      const ctx = {
        cwd,
        signal: AbortSignal.timeout(10000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const result = await tool.execute(
        "call-null",
        { agent: "hang", task: "test" },
        undefined,
        undefined,
        ctx,
      );
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      await tracker.resultMessage;
    });
  });

  describe("session_start usage restoration and membership", () => {
    function makeUsageRun(
      overrides: Partial<UsageInstanceNode> = {},
    ): UsageInstanceNode {
      return {
        id: "run-1",
        agent: "hang",
        instanceName: "able-fox",
        ordinal: 1,
        startedAt: 1_000,
        status: "success",
        durationMs: 120,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 1,
          cacheWrite: 0,
          cost: 0.02,
          turns: 1,
        },
        children: [],
        ...overrides,
      };
    }

    function makeSessionStartCtx(
      cwd: string,
      entries: readonly unknown[],
      branchEntries: readonly unknown[] = [],
    ): ExtensionContext {
      return {
        ...makeBareCtx(cwd),
        sessionManager: {
          getEntries: () => entries,
          getBranch: () => branchEntries,
        },
      } as unknown as ExtensionContext;
    }

    test.each(["startup", "reload", "new", "resume", "fork"] as const)(
      "restores valid v1 entries across complete getEntries() on session_start reason %s",
      async (reason) => {
        const appended: Array<{ customType: string; data: unknown }> = [];
        const { tool, cwd } = await setupTest({
          appendEntry: (customType, data) => {
            appended.push({ customType, data });
          },
        });
        const branchRun = makeUsageRun({
          id: `branch-run-${reason}`,
          instanceName: "shared-name",
          ordinal: 2,
          startedAt: 2_000,
          children: [
            makeUsageRun({
              id: `nested-${reason}`,
              agent: "worker",
              instanceName: "nested-wren",
              ordinal: 1,
              startedAt: 2_050,
              omitted: {
                count: 1,
                totals: {
                  instances: 1,
                  statuses: {
                    running: 0,
                    success: 1,
                    error: 0,
                    cancelled: 0,
                  },
                  usage: {
                    input: 4,
                    output: 2,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: 0.01,
                    turns: 1,
                  },
                  durationMs: 30,
                  byAgent: {
                    worker: {
                      instances: 1,
                      statuses: {
                        running: 0,
                        success: 1,
                        error: 0,
                        cancelled: 0,
                      },
                      usage: {
                        input: 4,
                        output: 2,
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: 0.01,
                        turns: 1,
                      },
                      durationMs: 30,
                    },
                  },
                },
              },
            }),
          ],
        });
        const offBranchRun = makeUsageRun({
          id: `off-branch-${reason}`,
          instanceName: "shared-name",
          ordinal: 4,
          startedAt: 3_000,
        });

        const entries = [
          { type: "message", message: { role: "user", content: [] } },
          {
            type: "custom",
            customType: "subagent-usage",
            data: { v: 1, run: branchRun },
          },
          {
            type: "custom",
            customType: "other-ext",
            data: { unrelated: true },
          },
          {
            type: "custom",
            customType: "subagent-usage",
            data: { v: 1, run: offBranchRun },
          },
        ];

        await emitSessionStart(tool, cwd, {
          reason,
          // Keep getBranch empty to prove restoration reads complete getEntries().
          ctx: makeSessionStartCtx(cwd, entries, []),
        });

        // Restoration never re-appends entries.
        expect(appended).toHaveLength(0);

        const sessionUsage = querySessionUsage();
        expect(sessionUsage.runs.map((run) => run.id)).toEqual([
          `off-branch-${reason}`,
          `branch-run-${reason}`,
        ]);
        expect(sessionUsage.rollup.instances).toBe(4);
        expect(sessionUsage.rollup.usage.input).toBe(34);

        // Exact ID and latest-name root matching, plus represented nested lookup.
        expect(queryRootRunUsage(`branch-run-${reason}`)?.run.id).toBe(
          `branch-run-${reason}`,
        );
        expect(queryRootRunUsage("shared-name")?.run.id).toBe(
          `off-branch-${reason}`,
        );
        const nestedQuery = queryInstanceUsage(`nested-${reason}`);
        expect(nestedQuery?.rollup.instances).toBe(2);
        expect(nestedQuery?.rollup.usage.input).toBe(14);

        // Immutable query results.
        if (sessionUsage.runs[0]) {
          sessionUsage.runs[0].usage.input = 9_999;
        }
        expect(querySessionUsage().rollup.usage.input).toBe(34);
      },
    );

    test("skips malformed, unsupported, and repeated entries without blocking valid entries", async () => {
      const appended: Array<{ customType: string; data: unknown }> = [];
      const sentMessages: import("./helpers.js").SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
        appendEntry: (customType, data) => {
          appended.push({ customType, data });
        },
      });
      process.env.PI_SUBAGENT_DEPTH = "0";

      const validRun = makeUsageRun({
        id: "valid-hist",
        agent: "hang",
        instanceName: "valid-fox",
        ordinal: 3,
        startedAt: 1_000,
      });
      const duplicateValid = makeUsageRun({ ...validRun });
      const runningInvalid = makeUsageRun({
        id: "running-hist",
        status: "running",
        durationMs: undefined,
      });
      const sensitiveInvalid = {
        ...makeUsageRun({ id: "sensitive-hist" }),
        stderr: "leaked",
      };

      const entries = [
        null,
        { type: "custom", customType: "subagent-usage", data: "corrupt" },
        {
          type: "custom",
          customType: "subagent-usage",
          data: { v: 2, run: makeUsageRun({ id: "v2-hist" }) },
        },
        {
          type: "custom",
          customType: "subagent-usage",
          data: { v: 1, run: validRun, extra: "disallowed" },
        },
        {
          type: "custom",
          customType: "subagent-usage",
          data: { v: 1, run: runningInvalid },
        },
        {
          type: "custom",
          customType: "subagent-usage",
          data: { v: 1, run: sensitiveInvalid },
        },
        {
          type: "custom",
          customType: "subagent-usage",
          data: { v: 1, run: validRun },
        },
        {
          type: "custom",
          customType: "subagent-usage",
          data: { v: 1, run: duplicateValid },
        },
      ];

      const ctxA = makeSessionStartCtx(cwd, entries);
      await emitSessionStart(tool, cwd, { reason: "resume", ctx: ctxA });
      // Repeated restore on reload stays idempotent.
      await emitSessionStart(tool, cwd, { reason: "reload", ctx: ctxA });

      expect(querySessionUsage().runs).toHaveLength(1);
      expect(querySessionUsage().rollup.instances).toBe(1);

      // Next root run continues beyond restored ordinal 3 -> ordinal 4.
      await runTool(tool, { agent: "hang", task: "after-restore" }, ctxA);
      await waitForSentMessageCount(sentMessages, 2);
      await waitForRunJobsCleared();

      const sessA = querySessionUsage();
      expect(sessA.runs).toHaveLength(2);
      expect(sessA.runs[0]?.ordinal).toBe(4);
      expect(sessA.runs[1]?.ordinal).toBe(3);

      // Overlap with in-memory terminal run never duplicates totals.
      expect(appended).toHaveLength(1);
      const entriesWithOverlap = [
        ...entries,
        {
          type: "custom",
          customType: "subagent-usage",
          data: appended[0]?.data,
        },
      ];
      await emitSessionStart(tool, cwd, {
        reason: "reload",
        ctx: makeSessionStartCtx(cwd, entriesWithOverlap),
      });
      expect(querySessionUsage().runs).toHaveLength(2);
    });

    test("skips persistence for a root run ending after session_shutdown", async () => {
      const appended: Array<{ customType: string; data: unknown }> = [];
      const { tool, cwd } = await setupTest({
        appendEntry: (customType, data) => {
          appended.push({ customType, data });
        },
        piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
      });
      process.env.PI_SUBAGENT_DEPTH = "0";

      const ctx = makeSessionStartCtx(cwd, []);
      await emitSessionStart(tool, cwd, { reason: "startup", ctx });
      const controller = new AbortController();
      await runTool(
        tool,
        { agent: "hang", task: "in-flight" },
        ctx,
        controller.signal,
      );
      await waitForRunJobCount(1);

      await emitSessionShutdown(tool);
      controller.abort("cancel after session shutdown");
      await waitForRunJobsCleared();
      expect(appended).toHaveLength(0);
    });

    test("isolates getEntries and restoreSessionRuns failures without disrupting subsequent jobs", async () => {
      const sentMessages: import("./helpers.js").SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "0";

      await emitSessionStart(tool, cwd, {
        reason: "resume",
        ctx: {
          ...makeBareCtx(cwd),
          sessionManager: {
            getEntries: () => {
              throw new Error("getEntries boom");
            },
          },
        } as unknown as ExtensionContext,
      });

      const restoreSpy = spyOn(
        usageLedger,
        "restoreSessionRuns",
      ).mockImplementationOnce(() => {
        throw new Error("restore boom");
      });
      try {
        await emitSessionStart(tool, cwd, {
          reason: "resume",
          ctx: makeSessionStartCtx(cwd, []),
        });
      } finally {
        restoreSpy.mockRestore();
      }

      await runTool(
        tool,
        { agent: "hang", task: "after-restore-failure" },
        makeSessionStartCtx(cwd, []),
      );
      await waitForSentMessageCount(sentMessages, 2);
      await waitForRunJobsCleared();
      expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
      expect(querySessionUsage().runs).toHaveLength(1);
    });
  });
});
