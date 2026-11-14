import { beforeEach, describe, expect, test } from "bun:test";
import { jobsCommandHandler } from "../src/orchestration/jobs-command.js";
import {
  registerRunJob,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import {
  attachChildSubtree,
  registerRootInstance,
  resetUsageLedger,
  restoreSessionRuns,
  updateInstanceSelfUsage,
} from "../src/orchestration/usage-ledger.js";
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  patchProgressState,
  resetProgressStore,
} from "../src/progress/progress.js";
import { makeCommandContext, setupFixtureHooks } from "./fixtures.js";

setupFixtureHooks();

beforeEach(() => {
  resetRunRegistry();
  resetProgressStore();
  resetUsageLedger();
});

test.each([
  { name: "/jobs empty board shows no-jobs message", args: "" },
  { name: "/jobs ignores arguments", args: "some garbage args" },
])("$name", async (row) => {
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    row.args,
  );
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs shows active running jobs", async () => {
  const rid = "runs-active-test";
  createProgressState(rid, "test-agent", "do something", "test-instance");
  patchProgressState(rid, {
    toolCount: 3,
    contextTokens: 4000,
    contextWindowTokens: 10000,
  });
  registerRunJob({
    requestId: rid,
    agentName: "test-agent",
    instanceName: "test-instance",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  expect(output).toContain("test-agent");
  expect(output).toContain("test-instance");
  expect(output).toContain("[running]");
  expect(output).toContain("3 tools");
});

test("/jobs notification width is two less than board width", async () => {
  const rid = "width-job";
  createProgressState(rid, "width-agent", "task", "inst");
  registerRunJob({
    requestId: rid,
    agentName: "width-agent",
    instanceName: "inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg), 122),
    "",
  );
  const output = notices[0] ?? "";
  expect(output.match(/─+/)?.[0]?.length).toBe(109);
});

test("/jobs shows status sections after active jobs", async () => {
  const doneRid = "runs-done-test";
  createProgressState(doneRid, "done-agent", "finished task", "done-inst");
  finalizeProgressState(doneRid, "completed task");
  patchProgressState(doneRid, {
    toolCount: 1,
    contextTokens: 100,
    contextWindowTokens: 1000,
  });
  const activeRid = "runs-active-2";
  createProgressState(
    activeRid,
    "active-agent",
    "still running",
    "active-inst",
  );
  patchProgressState(activeRid, {
    toolCount: 5,
    contextTokens: 2000,
    contextWindowTokens: 8000,
  });
  registerRunJob({
    requestId: activeRid,
    agentName: "active-agent",
    instanceName: "active-inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  const activeIdx = output.indexOf("active-agent");
  const doneIdx = output.indexOf("done-agent");
  expect(activeIdx).toBeGreaterThan(-1);
  expect(doneIdx).toBeGreaterThan(-1);
  expect(activeIdx).toBeLessThan(doneIdx);
  expect(output).toContain("ACTIVE (1)");
  expect(output).toContain("SUCCEEDED (1)");
  expect(output).not.toContain("COMPLETED");
});

test("/jobs shows cancelled and error jobs", async () => {
  const errRid = "runs-error-test";
  createProgressState(errRid, "err-agent", "failed task", "err-inst");
  failProgressState(errRid, "something broke");
  patchProgressState(errRid, { toolCount: 2 });
  const cancelRid = "runs-cancel-test";
  createProgressState(
    cancelRid,
    "cancel-agent",
    "cancelled task",
    "cancel-inst",
  );
  cancelProgressState(cancelRid, "user aborted");
  patchProgressState(cancelRid, { toolCount: 0 });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  expect(output).toContain("FAILED (1)");
  expect(output).toContain("CANCELLED (1)");
  expect(output).toContain("[error]");
  expect(output).toContain("[cancelled]");
  expect(output).toContain("something broke");
  expect(output).toContain("user aborted");
  expect(output).not.toContain("COMPLETED");
});

test("/jobs active job not in progress store is skipped", async () => {
  registerRunJob({
    requestId: "orphan-job",
    agentName: "orphan-agent",
    instanceName: "orphan-inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  // No progress state for orphan-job, so board should be empty
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs completed job also in active registry excluded from completed list", async () => {
  const rid = "dual-state-job";
  createProgressState(rid, "dual-agent", "task", "dual-inst");
  finalizeProgressState(rid, "done output");
  registerRunJob({
    requestId: rid,
    agentName: "dual-agent",
    instanceName: "dual-inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  expect(output).toContain("dual-agent");
  // Appears once in active section, not duplicated in completed
  const firstIdx = output.indexOf("dual-agent");
  const lastIdx = output.lastIndexOf("dual-agent");
  expect(firstIdx).toBe(lastIdx);
});

test("/jobs sorts jobs within same category by startTime descending", async () => {
  const rid1 = "job-old";
  const rid2 = "job-new";
  const now = Date.now();
  createProgressState(rid1, "old-agent", "task", "inst");
  createProgressState(rid2, "new-agent", "task", "inst");
  patchProgressState(rid1, { startTime: now - 5000 });
  patchProgressState(rid2, { startTime: now });
  registerRunJob({
    requestId: rid1,
    agentName: "old-agent",
    instanceName: "inst",
    controller: new AbortController(),
    startedAt: now - 5000,
  });
  registerRunJob({
    requestId: rid2,
    agentName: "new-agent",
    instanceName: "inst",
    controller: new AbortController(),
    startedAt: now,
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  const oldIdx = output.indexOf("old-agent");
  const newIdx = output.indexOf("new-agent");
  expect(newIdx).toBeLessThan(oldIdx);
});

test("/jobs truncates long final output in board", async () => {
  const rid = "long-output-job";
  createProgressState(rid, "long-agent", "task", "inst");
  const longText = "charlie ".repeat(30);
  finalizeProgressState(rid, longText);
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).not.toContain(longText);
  expect(output).toContain("…");
});

test("/jobs skips zombie running jobs not in active registry", async () => {
  const rid = "zombie-job";
  createProgressState(rid, "zombie-agent", "task", "zombie-inst");
  // State is running but NOT in the active job registry — handler must skip it
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs uses singular 'tool' label when toolCount is 1", async () => {
  const rid = "singular-tool-job";
  createProgressState(rid, "agent-one", "task", "inst");
  patchProgressState(rid, { toolCount: 1 });
  finalizeProgressState(rid, "done");
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg), 200),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("1 tool ");
  expect(output).not.toContain("1 tools");
});

test("/jobs uses plural 'tools' label when toolCount is not 1", async () => {
  const rid = "plural-tools-job";
  createProgressState(rid, "agent-many", "task", "inst");
  patchProgressState(rid, { toolCount: 0 });
  finalizeProgressState(rid, "done");
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg), 200),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("0 tools");
});

test("/jobs shows errorText body for error state when no finalOutput", async () => {
  const rid = "error-body-job";
  createProgressState(rid, "err-agent", "task", "inst");
  failProgressState(rid, "disk full");
  patchProgressState(rid, { toolCount: 0 });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("disk full");
});

test("/jobs does not truncate body text at exactly 120 chars", async () => {
  const rid = "exact-120-job";
  createProgressState(rid, "agent-120", "task", "inst");
  const exactText = "alpha ".repeat(20);
  finalizeProgressState(rid, exactText);
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg), 200),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("alpha ".repeat(10));
});

test("/jobs truncates body text at 121 chars", async () => {
  const rid = "121-char-job";
  createProgressState(rid, "agent-121", "task", "inst");
  const text121 = `${"b ".repeat(60)}b`;
  finalizeProgressState(rid, text121);
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).not.toContain(text121);
  expect(output).toContain("…");
});

test("/jobs propagates renderer failure without notifying", async () => {
  const rid = "failing-renderer-job";
  createProgressState(rid, "renderer-agent", "task", "inst");
  registerRunJob({
    requestId: rid,
    agentName: "renderer-agent",
    instanceName: "inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  const ctx = {
    cwd: "/tmp",
    ui: {
      notify: (msg: string): void => {
        notices.push(msg);
      },
      custom: async (): Promise<string> => {
        throw new Error("renderer down");
      },
    },
  } as unknown as Parameters<typeof jobsCommandHandler>[0];
  await expect(jobsCommandHandler(ctx, "")).rejects.toThrow("renderer down");
  expect(notices).toEqual([]);
});

describe("jobs board rendering", () => {
  test("jobsCommandHandler renders board with active and completed jobs", async () => {
    resetRunRegistry();
    resetProgressStore();

    const notices: string[] = [];
    const ctx = makeCommandContext((msg) => notices.push(msg));

    // Create some progress states
    const activeRid = "active-job";
    const completedRid = "completed-job";

    createProgressState(activeRid, "active-agent", "running task", "inst-1");
    createProgressState(
      completedRid,
      "completed-agent",
      "finished task",
      "inst-2",
    );

    // Register active job
    registerRunJob({
      requestId: activeRid,
      agentName: "active-agent",
      instanceName: "inst-1",
      controller: new AbortController(),
      startedAt: Date.now(),
    });

    // Finalize completed job
    finalizeProgressState(completedRid, "output");

    await jobsCommandHandler(ctx, "");

    expect(notices).toHaveLength(1);
    const output = notices[0] ?? "";
    expect(output).toContain("active-agent");
    expect(output).toContain("completed-agent");
    expect(output).toContain("ACTIVE (1)");
    expect(output).toContain("SUCCEEDED (1)");
  });

  test("jobsCommandHandler handles empty board", async () => {
    resetRunRegistry();
    resetProgressStore();
    resetUsageLedger();

    const notices: string[] = [];
    const ctx = makeCommandContext((msg) => notices.push(msg));

    await jobsCommandHandler(ctx, "");

    expect(notices).toEqual(["No /run jobs in this session."]);
  });
});

describe("jobs session accounting", () => {
  function makeAdditive(cost: number) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost,
      turns: 1,
    };
  }

  function makeChild(
    id: string,
    agent: string,
    instanceName: string,
    startedAt: number,
    cost: number,
  ) {
    return {
      id,
      agent,
      instanceName,
      ordinal: 1,
      startedAt,
      status: "success" as const,
      usage: makeAdditive(cost),
      children: [],
    };
  }

  test("nonempty board precedes sections with ledger session totals", async () => {
    const r1 = "sess-r1";
    const r2 = "sess-r2";
    expect(
      registerRootInstance({
        id: r1,
        agent: "build",
        instanceName: "inst-1",
        startedAt: 1000,
      }).ok,
    ).toBe(true);
    expect(
      registerRootInstance({
        id: r2,
        agent: "review",
        instanceName: "inst-2",
        startedAt: 2000,
      }).ok,
    ).toBe(true);
    updateInstanceSelfUsage(r1, makeAdditive(0.02));
    updateInstanceSelfUsage(r2, makeAdditive(0.01));
    expect(
      attachChildSubtree(
        r1,
        makeChild("sess-c1", "worker", "child-1", 1100, 0.03),
      ).ok,
    ).toBe(true);

    createProgressState(r1, "build", "do task one", "inst-1");
    createProgressState(r2, "review", "do task two", "inst-2");
    registerRunJob({
      requestId: r1,
      agentName: "build",
      instanceName: "inst-1",
      controller: new AbortController(),
      startedAt: Date.now(),
    });
    finalizeProgressState(r2, "done");

    const notices: string[] = [];
    await jobsCommandHandler(
      makeCommandContext((msg) => notices.push(msg)),
      "",
    );
    expect(notices).toHaveLength(1);
    const output = notices[0] ?? "";
    expect(output.indexOf("Session")).toBeLessThan(
      output.indexOf("ACTIVE (1)"),
    );
    const sessionLine =
      output.split("\n").find((l) => l.includes("Session")) ?? "";
    expect(sessionLine).toContain(
      "<fg:muted><b>Session</b></fg:muted><fg:muted> · 2 runs · 3 instances",
    );
    expect(output).toContain("$0.0600");
    expect(sessionLine).not.toContain("do task");
  });

  test("restored runs count in session without gaining job cards", async () => {
    restoreSessionRuns([
      {
        id: "restored-1",
        agent: "planner",
        instanceName: "restored-inst",
        ordinal: 1,
        startedAt: 500,
        status: "success",
        durationMs: 100,
        usage: makeAdditive(0.04),
        children: [],
      },
    ]);
    const live = "live-only";
    expect(
      registerRootInstance({
        id: live,
        agent: "build",
        instanceName: "live-inst",
        startedAt: 1000,
      }).ok,
    ).toBe(true);
    updateInstanceSelfUsage(live, makeAdditive(0.01));
    createProgressState(live, "build", "live task", "live-inst");
    registerRunJob({
      requestId: live,
      agentName: "build",
      instanceName: "live-inst",
      controller: new AbortController(),
      startedAt: Date.now(),
    });

    const notices: string[] = [];
    await jobsCommandHandler(
      makeCommandContext((msg) => notices.push(msg)),
      "",
    );
    const output = notices[0] ?? "";
    expect(output).toContain("<fg:muted><b>Session</b></fg:muted>");
    expect(output).toContain("2 runs");
    expect(output).toContain("2 instances");
    expect(output).toContain("$0.0500");
    expect(output).toContain("live-inst");
    expect(output).not.toContain("restored-inst");
  });

  test("empty board keeps no-jobs notice when ledger holds restored runs", async () => {
    restoreSessionRuns([
      {
        id: "restored-only",
        agent: "planner",
        instanceName: "ghost-inst",
        ordinal: 1,
        startedAt: 500,
        status: "success",
        durationMs: 50,
        usage: makeAdditive(0.02),
        children: [],
      },
    ]);
    const notices: string[] = [];
    await jobsCommandHandler(
      makeCommandContext((msg) => notices.push(msg)),
      "",
    );
    expect(notices).toEqual(["No /run jobs in this session."]);
  });

  test.each([
    { status: "running", runCost: false },
    { status: "success", runCost: true },
  ] as const)(
    "$status job cards with descendants show run cost only when settled ($runCost)",
    async ({ status, runCost }) => {
      const rid = "cost-root";
      expect(
        registerRootInstance({
          id: rid,
          agent: "build",
          instanceName: "cost-inst",
          startedAt: 1000,
        }).ok,
      ).toBe(true);
      updateInstanceSelfUsage(rid, makeAdditive(0.01));
      expect(
        attachChildSubtree(rid, {
          ...makeChild("cost-child", "worker", "child-inst", 1100, 0.02),
          omitted: {
            count: 1,
            totals: {
              instances: 1,
              statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
              usage: makeAdditive(0.005),
              durationMs: 10,
              byAgent: {
                helper: {
                  instances: 1,
                  statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
                  usage: makeAdditive(0.005),
                  durationMs: 10,
                },
              },
            },
          },
        }).ok,
      ).toBe(true);
      createProgressState(rid, "build", "secret task text", "cost-inst");
      patchProgressState(rid, {
        modelDisplay: "provider/model:high",
        status,
        ...(status === "running" ? {} : { durationMs: 50 }),
      });
      registerRunJob({
        requestId: rid,
        agentName: "build",
        instanceName: "cost-inst",
        controller: new AbortController(),
        startedAt: Date.now(),
      });
      const notices: string[] = [];
      await jobsCommandHandler(
        makeCommandContext((msg) => notices.push(msg), 200),
        "",
      );
      const output = notices[0] ?? "";
      expect(output).toContain("provider/model:high");
      const tallyLine =
        output.split("\n").find((l) => l.includes("spawned")) ?? "";
      expect(tallyLine).not.toBe("");
      expect(tallyLine.includes("run $")).toBe(runCost);
      const footerLine =
        output.split("\n").find((l) => l.includes("provider/model:high")) ?? "";
      expect(footerLine).not.toContain("run $");
      expect(footerLine).not.toContain("secret task");
      const bodyIdx = output.indexOf("secret task text");
      const tallyIdx = output.indexOf("spawned");
      expect(bodyIdx).toBeGreaterThanOrEqual(0);
      expect(tallyIdx).toBeGreaterThan(bodyIdx);
    },
  );

  test("leaf cards retain existing footer without run cost", async () => {
    const rid = "leaf-root";
    expect(
      registerRootInstance({
        id: rid,
        agent: "solo",
        instanceName: "solo-inst",
        startedAt: 1000,
      }).ok,
    ).toBe(true);
    updateInstanceSelfUsage(rid, makeAdditive(0.0123));
    createProgressState(rid, "solo", "leaf task", "solo-inst");
    patchProgressState(rid, { modelDisplay: "provider/model:low" });
    registerRunJob({
      requestId: rid,
      agentName: "solo",
      instanceName: "solo-inst",
      controller: new AbortController(),
      startedAt: Date.now(),
    });
    const notices: string[] = [];
    await jobsCommandHandler(
      makeCommandContext((msg) => notices.push(msg)),
      "",
    );
    const output = notices[0] ?? "";
    expect(output).toContain("provider/model:low");
    expect(output).not.toContain("run $");
    expect(output).toContain("<fg:muted><b>Session</b></fg:muted>");
    expect(output).toContain("1 run");
    expect(output).toContain("1 instance");
    expect(output).toContain("$0.0123");
  });
});
