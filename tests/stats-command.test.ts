import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  listRunJobs,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import { statsCommandHandler } from "../src/orchestration/stats-command.js";
import {
  attachChildSubtree,
  queryRootRunUsage,
  querySessionUsage,
  registerRootInstance,
  resetUsageLedger,
  restoreSessionRuns,
  transitionInstanceStatus,
  updateInstanceSelfUsage,
} from "../src/orchestration/usage-ledger.js";
import {
  renderStatsBoard,
  renderStatsRunBoard,
} from "../src/output/stats-board.js";
import { resetProgressStore } from "../src/progress/progress-state.js";
import type {
  AccountingRollup,
  AdditiveUsage,
  UsageInstanceNode,
} from "../src/shared/types.js";
import {
  computeSubtreeRollup,
  createEmptyAdditiveUsage,
} from "../src/shared/usage-accounting.js";
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

async function runStatsAtWidth(
  width: number,
  ...argsList: string[]
): Promise<string[]> {
  const notices: string[] = [];
  const ctx = makeCommandContext((msg) => notices.push(msg), width);
  for (const args of argsList) {
    await statsCommandHandler(ctx, args);
  }
  return notices;
}

async function runStats(...argsList: string[]): Promise<string[]> {
  return runStatsAtWidth(300, ...argsList);
}

const identityTheme = {
  fg: (_color: unknown, text: string): string => text,
  bg: (_color: unknown, text: string): string => text,
  bold: (text: string): string => text,
  italic: (text: string): string => text,
  underline: (text: string): string => text,
  strikethrough: (text: string): string => text,
};

function renderBoardLines(
  width: number,
  runs = querySessionUsage().runs,
  rollup = querySessionUsage().rollup,
): string[] {
  return renderStatsBoard(runs, rollup, identityTheme as never, width).render(
    width,
  );
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

  test("reports styled session totals across live, restored, and omitted descendants without mutating state", async () => {
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

    const notices = await runStats("");
    expect(notices).toHaveLength(1);
    const output = notices[0] ?? "";
    expect(output).toContain("Session");
    expect(output).toContain("2 runs");
    expect(output).toContain("5 instances");
    expect(output).toContain("↑350");
    expect(output).toContain("↓155");
    expect(output).toContain("R55");
    expect(output).toContain("W15");
    expect(output).toContain("$0.0470");
    expect(output).toContain("planner");
    expect(output).toContain("✓1");
    expect(output).toContain("⟳1");
    expect(output).toContain("↑300");
    expect(output).toContain("$0.0400");
    expect(output).toContain("2.0s");
    expect(output).toContain("worker");
    expect(output).toContain("✗1");
    expect(output).toContain("⊘1");
    expect(output).toContain("$0.0070");
    expect(output).toContain("1.2s");
    expect(output).toContain("RUNS (2)");
    expect(output).toContain("live-falcon");
    expect(output).toContain("forked-hawk");
    expect(output).toContain("spawned");
    expect(output.indexOf("live-falcon")).toBeLessThan(
      output.indexOf("forked-hawk"),
    );
    expect(querySessionUsage()).toEqual(before);
    expect(listRunJobs()).toEqual([]);
    const again = await runStats("");
    expect(again).toEqual(notices);
  });

  test("formats styled token counts compactly and singular counts without plurals", async () => {
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

    const output = (await runStats(""))[0] ?? "";
    expect(output).toContain("Session");
    expect(output).toContain("1 run");
    expect(output).toContain("1 instance");
    expect(output).toContain("↑412k");
    expect(output).toContain("↓38k");
    expect(output).toContain("R1.2M");
    expect(output).toContain("W40k");
    expect(output).toContain("$3.1840");
    expect(output).toContain("12m 4s");
    expect(output).toContain("swift-otter");
    expect(output).not.toContain("spawned");
  });

  test("reports styled agents whose names shadow prototype members", async () => {
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

    const output = (await runStats(""))[0] ?? "";
    expect(output).toContain("__proto__");
    expect(output).toContain("↑12");
    expect(output).toContain("↓8");
    expect(output).toContain("$0.0050");
    expect(output).toContain("1.0s");
    expect(output).not.toMatch(/R\d/);
    expect(output).toContain("proto-owl");
  });

  test("orders runs recent-first with ordinal threshold and leaf fallback", async () => {
    registerRootInstance({
      id: "old-root",
      agent: "planner",
      instanceName: "old-falcon",
      startedAt: 1_000,
    });
    registerRootInstance({
      id: "new-root",
      agent: "planner",
      instanceName: "new-falcon",
      startedAt: 2_000,
    });
    attachChildSubtree(
      "new-root",
      makeNode({
        id: "new-child",
        agent: "worker",
        instanceName: "child-jay",
        startedAt: 2_100,
        status: "success",
        durationMs: 200,
        usage: makeUsage({ input: 5, output: 5, cost: 0.001, turns: 1 }),
      }),
    );

    const output = (await runStats(""))[0] ?? "";
    expect(output.indexOf("new-falcon")).toBeLessThan(
      output.indexOf("old-falcon"),
    );
    expect(output).toContain("#2");
    expect(output).not.toContain("#1");
    expect(output.match(/spawned/g)?.length).toBe(1);
    expect(output).toContain("[running]");
    expect(output).toContain("$");
  });

  test("consumes width-safe run tallies with truncation and suppression", async () => {
    registerRootInstance({
      id: "tally-root",
      agent: "planner",
      instanceName: "tally-falcon",
      startedAt: 1_000,
    });
    const agents = ["alpha", "beta", "gamma", "delta", "epsilon"];
    let at = 1_100;
    for (const agent of agents) {
      attachChildSubtree(
        "tally-root",
        makeNode({
          id: `child-${agent}`,
          agent,
          instanceName: `inst-${agent}`,
          startedAt: at,
          status: "success",
          durationMs: 100,
          usage: makeUsage({ input: 10, output: 5, cost: 0.001, turns: 1 }),
        }),
      );
      at += 100;
    }

    const wide = (await runStatsAtWidth(300, ""))[0] ?? "";
    for (const agent of agents) expect(wide).toContain(agent);
    expect(wide).not.toContain("+");
    expect(wide).toContain("5 spawned");

    const narrow = (await runStatsAtWidth(60, ""))[0] ?? "";
    expect(narrow).toContain("spawned");
    expect(narrow).toContain("+");
    expect(narrow).toContain("more");
    const narrowBoard = renderBoardLines(58).join("\n");
    const narrowTally = narrowBoard
      .split("\n")
      .filter((line) => line.includes("spawned"))
      .join(" ");
    expect(narrowTally).toContain("epsilon");
    expect(narrowTally).not.toContain("alpha");
    expect(narrowTally).toMatch(/\+\d+ more/);

    const tiny = (await runStatsAtWidth(10, ""))[0] ?? "";
    expect(tiny).not.toContain("spawned");
    expect(tiny.length).toBeGreaterThan(0);
    const tinyBoard = renderBoardLines(20).join("\n");
    expect(tinyBoard).not.toContain("spawned");
    expect(tinyBoard).toContain("tally-falcon");
  });

  test("stats run tally omits run suffix while header retains subtree cost", async () => {
    registerRootInstance({
      id: "stats-run-root",
      agent: "planner",
      instanceName: "cost-falcon",
      startedAt: 1_000,
    });
    updateInstanceSelfUsage("stats-run-root", makeUsage({ cost: 0.01 }));
    attachChildSubtree(
      "stats-run-root",
      makeNode({
        id: "stats-child",
        agent: "worker",
        instanceName: "child-jay",
        startedAt: 1_100,
        status: "success",
        usage: makeUsage({ cost: 0.02 }),
      }),
    );
    const output = (await runStats(""))[0] ?? "";
    expect(output).toContain("1 spawned");
    expect(output).toContain("$0.0300");
    const tallyLine =
      output.split("\n").find((l) => l.includes("spawned")) ?? "";
    expect(tallyLine).not.toContain("run $");
    expect(tallyLine).toContain("\u27131");
    expect(output.match(/run \$/g)?.length ?? 0).toBe(0);
  });

  test("omits zero cache parts while preserving nonzero cache tokens", async () => {
    registerRootInstance({
      id: "cache-root",
      agent: "worker",
      instanceName: "cache-owl",
      startedAt: 1_000,
    });
    updateInstanceSelfUsage(
      "cache-root",
      makeUsage({ input: 10, output: 5, cost: 0.001, turns: 1 }),
    );
    const noCache = (await runStats(""))[0] ?? "";
    expect(noCache).toContain("↑10");
    expect(noCache).toContain("↓5");
    expect(noCache).not.toMatch(/R\d/);
    expect(noCache).not.toMatch(/W\d/);

    resetUsageLedger();
    registerRootInstance({
      id: "cache-root-2",
      agent: "worker",
      instanceName: "cache-owl-2",
      startedAt: 1_000,
    });
    updateInstanceSelfUsage(
      "cache-root-2",
      makeUsage({
        input: 10,
        output: 5,
        cacheRead: 7,
        cacheWrite: 3,
        cost: 0.002,
        turns: 1,
      }),
    );
    const withCache = (await runStats(""))[0] ?? "";
    expect(withCache).toContain("R7");
    expect(withCache).toContain("W3");
  });

  test("renders notify board two columns narrower with clamped geometry", async () => {
    registerRootInstance({
      id: "width-root",
      agent: "planner",
      instanceName: "width-falcon",
      startedAt: 1_000,
    });
    const output = (await runStatsAtWidth(122, ""))[0] ?? "";
    expect(output.match(/─+/)?.[0]?.length).toBe(111);

    for (const width of [0, 1, 2, 4]) {
      const notices = await runStatsAtWidth(width, "");
      expect(notices).toHaveLength(1);
      expect(notices[0]?.length).toBeGreaterThan(0);
    }
  });

  test("avoids background-bar wrapping under fixed width", async () => {
    registerRootInstance({
      id: "wrap-root",
      agent: "planner",
      instanceName: "wrap-falcon",
      startedAt: 1_000,
    });
    attachChildSubtree(
      "wrap-root",
      makeNode({
        id: "wrap-child",
        instanceName: "wrap-jay",
        startedAt: 1_100,
        status: "success",
        durationMs: 100,
        usage: makeUsage({ input: 10, output: 5, cost: 0.001, turns: 1 }),
      }),
    );
    for (const width of [40, 80, 120]) {
      for (const line of renderBoardLines(width)) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("matches runs by request id or latest instance name and renders the styled instance tree", async () => {
    jest.setSystemTime(10_000);
    try {
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
              usage: makeUsage({
                input: 20,
                output: 10,
                cost: 0.002,
                turns: 1,
              }),
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
      const [oldOutput, newOutput] = await runStats("run-old", "shared-falcon");
      expect(oldOutput).toContain("shared-falcon (run-old)");
      expect(oldOutput).toContain("1 instance");
      expect(oldOutput).toContain("✓0 ✗1 ⊘0 ⟳0");
      expect(oldOutput).toContain("↑10 ↓5");
      expect(oldOutput).toContain("$0.0010");
      expect(oldOutput).toContain("0.5s");
      expect(oldOutput).toContain("✗ planner shared-falcon");
      const newLines = (newOutput ?? "").split("\n");
      expect(newOutput).toContain("shared-falcon (run-new)");
      expect(newOutput).toContain("4 instances");
      expect(newOutput).toContain("✓2 ✗0 ⊘0 ⟳2");
      expect(newOutput).toContain("↑200 ↓85 R10");
      expect(newOutput).toContain("$0.0200");
      expect(newLines[0]).not.toContain("8s");
      expect(newOutput).toContain("⟳ planner #2 shared-falcon");
      expect(newOutput).toContain("· 8s ·");
      expect(newOutput).toContain("$0.0100");
      expect(newOutput).toContain("✓ worker #2 child-otter");
      expect(newOutput).toContain("1.2s");
      expect(newOutput).toContain("$0.0050");
      expect(newOutput).toContain("⟳ searcher leaf-wren");
      expect(newOutput).toContain("· 7s ·");
      expect(newOutput).toContain("$0.0020");
      expect(newOutput).toContain("+1 earlier");
      expect(newOutput).not.toContain("…");
      expect(newOutput?.indexOf("child-otter")).toBeLessThan(
        newOutput?.indexOf("leaf-wren") ?? 0,
      );
      expect(newOutput?.indexOf("+1 earlier")).toBeGreaterThan(
        newOutput?.indexOf("leaf-wren") ?? 0,
      );
      expect(newLines[0]).not.toContain("#1");
      expect(newOutput).toContain("searcher leaf-wren");
      expect(newOutput).not.toContain("#1 leaf-wren");
      expect(newOutput).toContain("#2");
      expect(newOutput).toContain("<fg:muted>");
      expect(newOutput).not.toContain("<fg:dim>");
      expect(newOutput).not.toContain("transcript");
    } finally {
      jest.useRealTimers();
    }
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
    const [output] = await runStats("par-run");
    expect(output).toContain("par-run (root-par)");
    expect(output).toContain("3 instances");
    expect(output).toContain("✓3 ✗0 ⊘0 ⟳0");
    expect(output).toContain("$0.0000");
    expect(output).toContain("4.0s");
    expect(output).not.toContain("6.0s");
    expect(output).not.toContain("10.0s");
    expect(output).toContain("✓ planner par-run · 4.0s · $0.0000");
    expect(output).toContain("✓ worker child-a · 3.0s · $0.0000");
    expect(output).toContain("✓ worker #2 child-b · 3.0s · $0.0000");
    expect(output?.indexOf("child-a")).toBeLessThan(
      output?.indexOf("child-b") ?? 0,
    );
    expect(output).not.toContain("+");
    expect(output).toContain("<fg:muted>");
    expect(output).not.toContain("<fg:dim>");
  });

  test("bounds oversized run queries to 50 explicit nodes with exact totals", async () => {
    registerRootInstance({
      id: "bulk-root",
      agent: "planner",
      instanceName: "bulk-run",
      startedAt: 1_000,
    });
    updateInstanceSelfUsage(
      "bulk-root",
      makeUsage({ input: 100, output: 50, cost: 0.01, turns: 1 }),
    );
    for (let i = 0; i < 60; i += 1) {
      attachChildSubtree(
        "bulk-root",
        makeNode({
          id: `bulk-${i}`,
          agent: "worker",
          instanceName: `bulk-inst-${i}`,
          ordinal: 1,
          startedAt: 1_100 + i,
          status: "success",
          durationMs: 100,
          usage: makeUsage({ input: 10, output: 5, cost: 0.001, turns: 1 }),
        }),
      );
    }
    transitionInstanceStatus("bulk-root", "success", { durationMs: 2_000 });
    const [output] = await runStats("bulk-run");
    expect(output).toContain("bulk-run (bulk-root)");
    expect(output).toContain("61 instances");
    expect(output).toContain("$0.0700");
    expect(output).toContain("2.0s");
    const treeLines = (output ?? "")
      .split("\n")
      .filter(
        (line) => line.includes("worker ") || line.includes("✓ planner "),
      );
    expect(treeLines.length).toBe(50);
    expect(output).toMatch(/\+\d+ earlier/);
    expect(output).not.toContain("bulk-inst-0");
    expect(output).toContain("bulk-inst-59");
  });

  test("renders run-board notification two columns narrower with clamped geometry", async () => {
    registerRootInstance({
      id: "geom-root",
      agent: "planner",
      instanceName: "geom-run",
      startedAt: 1_000,
    });
    attachChildSubtree(
      "geom-root",
      makeNode({
        id: "geom-child",
        instanceName: "geom-jay",
        startedAt: 1_100,
        status: "success",
        durationMs: 100,
        usage: makeUsage({ input: 10, output: 5, cost: 0.001, turns: 1 }),
      }),
    );
    const output = (await runStatsAtWidth(122, "geom-run"))[0] ?? "";
    for (const line of output.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
    expect(output).toContain("geom-run (geom-root)");
    expect(output).toContain("$0.0010");
    for (const width of [0, 1, 2, 4]) {
      const notices = await runStatsAtWidth(width, "geom-run");
      expect(notices).toHaveLength(1);
      expect(notices[0]?.length).toBeGreaterThan(0);
    }
    const match = queryRootRunUsage("geom-run");
    if (match) {
      for (const width of [40, 80, 120]) {
        const lines = renderStatsRunBoard(
          match.run,
          match.rollup,
          identityTheme as never,
        ).render(width);
        for (const line of lines) {
          expect(line.length).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  test("orders siblings ascending with indentation and earlier markers", async () => {
    registerRootInstance({
      id: "order-root",
      agent: "planner",
      instanceName: "order-run",
      startedAt: 1_000,
    });
    attachChildSubtree(
      "order-root",
      makeNode({
        id: "later",
        agent: "worker",
        instanceName: "later-jay",
        startedAt: 3_000,
        durationMs: 100,
      }),
    );
    attachChildSubtree(
      "order-root",
      makeNode({
        id: "earlier",
        agent: "worker",
        instanceName: "earlier-jay",
        startedAt: 2_000,
        durationMs: 200,
        children: [
          makeNode({
            id: "nested",
            instanceName: "nested-wren",
            startedAt: 2_100,
            durationMs: 50,
          }),
        ],
        omitted: makeOmitted("worker", {
          instances: 1,
          statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
          usage: makeUsage({ cost: 0.001 }),
          durationMs: 10,
        }),
      }),
    );
    transitionInstanceStatus("order-root", "success", { durationMs: 5_000 });
    const [output] = await runStats("order-run");
    expect(output?.indexOf("earlier-jay")).toBeLessThan(
      output?.indexOf("later-jay") ?? 0,
    );
    expect(output).toContain("  ✓ worker ");
    expect(output).toContain("    ✓ worker nested-wren");
    expect(output).toContain("+1 earlier");
    expect(output).not.toContain("transcript");
    expect(output?.split("\n")[0]).not.toContain("#1");
  });

  test("run board falls back to zero elapsed for unusable clock inputs", () => {
    const run = makeNode({
      id: "clock-root",
      agent: "planner",
      instanceName: "clock-run",
      status: "running",
      durationMs: undefined,
      startedAt: 2_000,
    });
    const nanNow = renderStatsRunBoard(
      run,
      computeSubtreeRollup(run),
      identityTheme as never,
      Number.NaN,
    ).render(80);
    expect(nanNow.join("\n")).toContain("· 0s ·");
    const badStart = makeNode({
      id: "clock-root",
      agent: "planner",
      instanceName: "clock-run",
      status: "running",
      durationMs: undefined,
      startedAt: Number.NaN,
    });
    const badStartLines = renderStatsRunBoard(
      badStart,
      computeSubtreeRollup(badStart),
      identityTheme as never,
      4_000,
    ).render(80);
    expect(badStartLines.join("\n")).toContain("· 0s ·");
  });

  test("run board omits duration segment for terminal nodes without durationMs", () => {
    const run = makeNode({
      id: "nodur-root",
      agent: "planner",
      instanceName: "nodur-run",
      status: "success",
      durationMs: undefined,
      children: [
        makeNode({
          id: "nodur-child",
          agent: "worker",
          instanceName: "nodur-leaf",
          durationMs: undefined,
        }),
      ],
    });
    const lines = renderStatsRunBoard(
      run,
      computeSubtreeRollup(run),
      identityTheme as never,
      2_000,
    ).render(80);
    expect(lines[0]?.trimEnd()).toBe(
      "planner nodur-run (nodur-root) · 2 instances · ✓2 ✗0 ⊘0 ⟳0 · ↑0 ↓0 · $0.0000",
    );
    const leaf = lines.find((line) => line.includes("nodur-leaf")) as string;
    expect(leaf?.trimEnd()).toBe("  ✓ worker nodur-leaf · $0.0000");
  });

  test("run board orders same-time siblings by agent, instance name, then id", () => {
    const run = makeNode({
      id: "tie-root",
      agent: "planner",
      instanceName: "tie-run",
      status: "success",
      durationMs: 5_000,
      children: [
        makeNode({
          id: "tie-z",
          agent: "beta",
          instanceName: "same-wren",
          durationMs: undefined,
        }),
        makeNode({
          id: "tie-a",
          agent: "alpha",
          instanceName: "one-wren",
          durationMs: undefined,
        }),
        makeNode({
          id: "tie-b2",
          agent: "beta",
          instanceName: "other-wren",
          status: "error",
          durationMs: undefined,
        }),
        makeNode({
          id: "tie-b1",
          agent: "beta",
          instanceName: "other-wren",
          status: "success",
          durationMs: undefined,
        }),
      ],
    });
    const joined = renderStatsRunBoard(
      run,
      computeSubtreeRollup(run),
      identityTheme as never,
      6_000,
    )
      .render(80)
      .join("\n");
    expect(joined.indexOf("alpha")).toBeLessThan(joined.indexOf("beta"));
    expect(joined.indexOf("✓ beta other-wren")).toBeLessThan(
      joined.indexOf("✗ beta other-wren"),
    );
    expect(joined.indexOf("other-wren")).toBeLessThan(
      joined.indexOf("same-wren"),
    );
  });
});

test("stats surfaces use muted information tokens with dim only for rulers", () => {
  resetUsageLedger();
  resetRunRegistry();
  resetProgressStore();
  registerRootInstance({
    id: "theme-stats",
    agent: "planner",
    instanceName: "theme-run",
    startedAt: 1000,
  });
  attachChildSubtree(
    "theme-stats",
    makeNode({
      id: "theme-child",
      instanceName: "theme-child",
      ordinal: 2,
      startedAt: 1100,
      status: "success",
      durationMs: 100,
    }),
  );
  updateInstanceSelfUsage(
    "theme-stats",
    makeUsage({ input: 100, output: 50, cost: 0.01, turns: 1 }),
  );
  const markerTheme = {
    fg: (color: unknown, text: string) => `[${color}]${text}[/${color}]`,
    bg: (color: unknown, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const { runs, rollup } = querySessionUsage();
  const board = renderStatsBoard(runs, rollup, markerTheme as never, 80)
    .render(80)
    .join("\n");
  expect(board).toContain("[muted]Session");
  expect(board).toContain("[muted]RUNS");
  expect(board).toContain("[dim]");
  expect(board).not.toContain("[dim]Session");
  const match = queryRootRunUsage("theme-run");
  if (match) {
    const runBoard = renderStatsRunBoard(
      match.run,
      match.rollup,
      markerTheme as never,
    )
      .render(80)
      .join("\n");
    expect(runBoard).toContain("[muted]planner theme-run");
    expect(runBoard).not.toContain("[dim]planner");
    expect(runBoard).not.toContain("[dim]");
    // Header and every usage-tree row carry the muted information role;
    // `dim` stays reserved for decorative rulers.
    expect(runBoard).toMatch(
      /\[muted\][\u2713\u2717\u2298\u27f3] planner theme-run/,
    );
    expect(runBoard).toMatch(
      /\[muted\] {2}[\u2713\u2717\u2298\u27f3] worker #2 theme-child/,
    );
  }
  resetUsageLedger();
  resetRunRegistry();
  resetProgressStore();
});
