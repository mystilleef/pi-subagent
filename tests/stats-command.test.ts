import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  listRunJobs,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import { statsCommandHandler } from "../src/orchestration/stats-command.js";
import {
  attachChildSubtree,
  querySessionUsage,
  registerRootInstance,
  resetUsageLedger,
  restoreSessionRuns,
  transitionInstanceStatus,
  updateInstanceSelfUsage,
} from "../src/orchestration/usage-ledger.js";
import { resetProgressStore } from "../src/progress/progress-state.js";
import type {
  AccountingRollup,
  AdditiveUsage,
  UsageInstanceNode,
} from "../src/shared/types.js";
import { createEmptyAdditiveUsage } from "../src/shared/usage-accounting.js";
import { makeCommandContext, setupFixtureHooks } from "./fixtures.js";

setupFixtureHooks();

beforeEach(() => {
  resetUsageLedger();
  resetRunRegistry();
  resetProgressStore();
});

afterEach(() => {
  resetUsageLedger();
  resetRunRegistry();
  resetProgressStore();
});

function makeUsage(overrides: Partial<AdditiveUsage> = {}): AdditiveUsage {
  return { ...createEmptyAdditiveUsage(), ...overrides };
}

function makeNode(overrides: Partial<UsageInstanceNode>): UsageInstanceNode {
  return {
    id: "node",
    agent: "worker",
    instanceName: "node",
    ordinal: 1,
    startedAt: 1_000,
    status: "success",
    durationMs: 100,
    usage: makeUsage(),
    children: [],
    ...overrides,
  };
}

function makeOmitted(agent: string, totals: Omit<AccountingRollup, "byAgent">) {
  return {
    count: totals.instances,
    totals: { ...totals, byAgent: { [agent]: { ...totals } } },
  };
}

async function runStats(...argsList: string[]): Promise<string[]> {
  const notices: string[] = [];
  const ctx = makeCommandContext((msg) => notices.push(msg));
  for (const args of argsList) {
    await statsCommandHandler(ctx, args);
  }
  return notices;
}

describe("statsCommandHandler", () => {
  test.each(["", "   "])(
    "notifies empty-session message for args %p",
    async (args) => {
      expect(await runStats(args)).toEqual([
        "No subagent runs in this session.",
      ]);
    },
  );

  test("notifies unmatched message for unknown runs and nested instances", async () => {
    registerRootInstance({
      id: "active-root",
      agent: "planner",
      instanceName: "calm-owl",
      startedAt: 2_000,
    });
    attachChildSubtree(
      "active-root",
      makeNode({
        id: "nested-child",
        instanceName: "nested-lynx",
        startedAt: 2_100,
        status: "running",
        durationMs: undefined,
      }),
    );

    expect(await runStats("  missing-run  ", "nested-child")).toEqual([
      'No run matches "missing-run".',
      'No run matches "nested-child".',
    ]);
  });

  test("reports session totals across live, restored, and omitted descendants without mutating state", async () => {
    restoreSessionRuns([
      makeNode({
        id: "restored-root",
        agent: "planner",
        instanceName: "forked-hawk",
        durationMs: 2_000,
        usage: makeUsage({
          input: 100,
          output: 50,
          cacheRead: 25,
          cacheWrite: 5,
          cost: 0.01,
          turns: 2,
        }),
        omitted: makeOmitted("worker", {
          instances: 2,
          statuses: { running: 0, success: 1, error: 1, cancelled: 0 },
          usage: makeUsage({
            input: 40,
            output: 20,
            cacheRead: 10,
            cost: 0.005,
            turns: 2,
          }),
          durationMs: 800,
        }),
      }),
    ]);
    registerRootInstance({
      id: "live-root",
      agent: "planner",
      instanceName: "live-falcon",
      startedAt: 2_000,
    });
    updateInstanceSelfUsage(
      "live-root",
      makeUsage({
        input: 200,
        output: 80,
        cacheRead: 20,
        cacheWrite: 10,
        cost: 0.03,
        turns: 3,
      }),
    );
    attachChildSubtree(
      "live-root",
      makeNode({
        id: "live-child",
        instanceName: "child-jay",
        startedAt: 2_100,
        status: "running",
        durationMs: undefined,
      }),
    );
    transitionInstanceStatus("live-child", "cancelled", {
      durationMs: 400,
      usage: makeUsage({ input: 10, output: 5, cost: 0.002, turns: 1 }),
    });
    const before = querySessionUsage();

    expect(await runStats("")).toEqual([
      [
        "Session · 2 runs · 5 instances · ↑350 ↓155 R55 W15 · $0.0470",
        "planner 2 · ✓1 ✗0 ⊘0 ⟳1 · ↑300 ↓130 R45 W15 · $0.0400 · 2.0s",
        "worker  3 · ✓1 ✗1 ⊘1 ⟳0 · ↑50 ↓25 R10 · $0.0070 · 1.2s",
      ].join("\n"),
    ]);
    expect(querySessionUsage()).toEqual(before);
    expect(listRunJobs()).toEqual([]);
  });

  test("formats token counts compactly and singular counts without plurals", async () => {
    registerRootInstance({
      id: "big-root",
      agent: "build",
      instanceName: "swift-otter",
      startedAt: 1_000,
    });
    transitionInstanceStatus("big-root", "success", {
      durationMs: 724_000,
      usage: makeUsage({
        input: 412_000,
        output: 38_000,
        cacheRead: 1_200_000,
        cacheWrite: 40_000,
        cost: 3.184,
        turns: 9,
      }),
    });

    expect(await runStats("")).toEqual([
      [
        "Session · 1 run · 1 instance · ↑412k ↓38k R1.2M W40k · $3.1840",
        "build 1 · ✓1 ✗0 ⊘0 ⟳0 · ↑412k ↓38k R1.2M W40k · $3.1840 · 12m 4s",
      ].join("\n"),
    ]);
  });

  test("reports agents whose names shadow prototype members", async () => {
    registerRootInstance({
      id: "proto-root",
      agent: "__proto__",
      instanceName: "proto-owl",
      startedAt: 1_000,
    });
    transitionInstanceStatus("proto-root", "success", {
      durationMs: 1_000,
      usage: makeUsage({ input: 12, output: 8, cost: 0.005, turns: 1 }),
    });

    expect(await runStats("")).toEqual([
      [
        "Session · 1 run · 1 instance · ↑12 ↓8 · $0.0050",
        "__proto__ 1 · ✓1 ✗0 ⊘0 ⟳0 · ↑12 ↓8 · $0.0050 · 1.0s",
      ].join("\n"),
    ]);
  });

  test("matches runs by request id or latest instance name and renders the instance tree", async () => {
    registerRootInstance({
      id: "run-old",
      agent: "planner",
      instanceName: "shared-falcon",
      startedAt: 1_000,
    });
    transitionInstanceStatus("run-old", "error", {
      durationMs: 500,
      usage: makeUsage({ input: 10, output: 5, cost: 0.001, turns: 1 }),
    });
    registerRootInstance({
      id: "run-new",
      agent: "planner",
      instanceName: "shared-falcon",
      startedAt: 2_000,
    });
    updateInstanceSelfUsage(
      "run-new",
      makeUsage({
        input: 100,
        output: 40,
        cacheRead: 10,
        cost: 0.01,
        turns: 1,
      }),
    );
    attachChildSubtree(
      "run-new",
      makeNode({
        id: "child-1",
        agent: "worker",
        instanceName: "child-otter",
        ordinal: 2,
        startedAt: 2_100,
        durationMs: 1_200,
        usage: makeUsage({ input: 50, output: 20, cost: 0.005, turns: 1 }),
        children: [
          makeNode({
            id: "grandchild-1",
            agent: "searcher",
            instanceName: "leaf-wren",
            startedAt: 2_200,
            status: "running",
            durationMs: undefined,
            usage: makeUsage({ input: 20, output: 10, cost: 0.002, turns: 1 }),
          }),
        ],
        omitted: makeOmitted("searcher", {
          instances: 1,
          statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
          usage: makeUsage({ input: 30, output: 15, cost: 0.003, turns: 1 }),
          durationMs: 600,
        }),
      }),
    );

    expect(await runStats("run-old", "shared-falcon")).toEqual([
      [
        "shared-falcon (run-old) · 1 instance · ✓0 ✗1 ⊘0 ⟳0 · ↑10 ↓5 · $0.0010 · 0.5s",
        "✗ planner #1 shared-falcon · 0.5s · $0.0010",
      ].join("\n"),
      [
        "shared-falcon (run-new) · 4 instances · ✓2 ✗0 ⊘0 ⟳2 · ↑200 ↓85 R10 · $0.0200",
        "⟳ planner #2 shared-falcon · $0.0100",
        "  ✓ worker #2 child-otter · 1.2s · $0.0050",
        "    ⟳ searcher #1 leaf-wren · $0.0020",
        "    … 1 omitted · ↑30 ↓15 · $0.0030",
      ].join("\n"),
    ]);
  });

  test("shows the root's own duration in the run header rather than summed instance time", async () => {
    registerRootInstance({
      id: "root-par",
      agent: "planner",
      instanceName: "par-run",
      startedAt: 1_000,
    });
    for (const [id, ordinal, startedAt] of [
      ["child-a", 1, 1_100],
      ["child-b", 2, 1_200],
    ] as const) {
      attachChildSubtree(
        "root-par",
        makeNode({
          id,
          instanceName: id,
          ordinal,
          startedAt,
          durationMs: 3_000,
        }),
      );
    }
    transitionInstanceStatus("root-par", "success", { endedAt: 5_000 });

    expect(await runStats("par-run")).toEqual([
      [
        "par-run (root-par) · 3 instances · ✓3 ✗0 ⊘0 ⟳0 · ↑0 ↓0 · $0.0000 · 4.0s",
        "✓ planner #1 par-run · 4.0s · $0.0000",
        "  ✓ worker #1 child-a · 3.0s · $0.0000",
        "  ✓ worker #2 child-b · 3.0s · $0.0000",
      ].join("\n"),
    ]);
  });
});
