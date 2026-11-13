import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attachChildSubtree,
  queryInstanceUsage,
  queryRootRunUsage,
  querySessionUsage,
  registerRootInstance,
  resetUsageLedger,
  restoreSessionRuns,
  snapshotInstanceUsage,
  transitionInstanceStatus,
  updateInstanceSelfUsage,
} from "../src/orchestration/usage-ledger.js";
import type {
  AccountingStatus,
  AdditiveUsage,
  UsageInstanceNode,
} from "../src/shared/types.js";
import { createEmptyAdditiveUsage } from "../src/shared/usage-accounting.js";

const PROTO_AGENT = "__proto__";

function makeUsage(overrides: Partial<AdditiveUsage> = {}): AdditiveUsage {
  return {
    ...createEmptyAdditiveUsage(),
    ...overrides,
  };
}

function makeBoundaryNode(
  overrides: Partial<UsageInstanceNode> = {},
): UsageInstanceNode {
  return {
    id: "child-1",
    agent: "explorer",
    instanceName: "swift-fox",
    ordinal: 1,
    startedAt: 2_000,
    status: "running",
    usage: makeUsage(),
    children: [],
    ...overrides,
  };
}

describe("usage-ledger", () => {
  beforeEach(resetUsageLedger);
  afterEach(resetUsageLedger);

  test("registers root instances with 1-based per-agent ordinals", () => {
    const r1 = registerRootInstance({
      id: "root-1",
      agent: "explorer",
      instanceName: "able-badger",
      startedAt: 1_000,
    });
    const r2 = registerRootInstance({
      id: "root-2",
      agent: "explorer",
      instanceName: "bold-eagle",
      startedAt: 1_100,
    });
    const r3 = registerRootInstance({
      id: "root-3",
      agent: "worker",
      instanceName: "calm-heron",
      startedAt: 1_200,
    });
    const r4 = registerRootInstance({
      id: "root-4",
      agent: "explorer",
      instanceName: "dawn-lynx",
      startedAt: 1_300,
    });

    expect(r1.ok && r1.value.ordinal).toBe(1);
    expect(r2.ok && r2.value.ordinal).toBe(2);
    expect(r3.ok && r3.value.ordinal).toBe(1);
    expect(r4.ok && r4.value.ordinal).toBe(3);
    expect(r1.ok && r1.value.status).toBe("running");
    expect(r1.ok && r1.value.durationMs).toBeUndefined();
  });

  test("rejects duplicate root registration ids without mutating state", () => {
    registerRootInstance({
      id: "root-1",
      agent: "explorer",
      instanceName: "able-badger",
      startedAt: 1_000,
    });

    expect(
      registerRootInstance({
        id: "root-1",
        agent: "worker",
        instanceName: "other",
        startedAt: 2_000,
      }).ok,
    ).toBe(false);

    const session = querySessionUsage();
    expect(session.runs).toHaveLength(1);
    expect(session.runs[0]?.agent).toBe("explorer");
  });

  test("updates self usage while excluding context size fields and transitions terminal statuses", () => {
    registerRootInstance({
      id: "r-success",
      agent: "explorer",
      instanceName: "fast-falcon",
      startedAt: 1_000,
    });
    registerRootInstance({
      id: "r-error",
      agent: "worker",
      instanceName: "keen-koala",
      startedAt: 1_100,
    });
    registerRootInstance({
      id: "r-cancelled",
      agent: "worker",
      instanceName: "lucky-lemur",
      startedAt: 1_200,
    });

    const usageRes = updateInstanceSelfUsage("r-success", {
      input: 50,
      output: 25,
      cacheRead: 10,
      cacheWrite: 5,
      cost: 0.037,
      turns: 2,
      contextTokens: 9_999,
      contextWindowTokens: 200_000,
    });
    expect(usageRes.ok).toBe(true);
    if (usageRes.ok) {
      expect(usageRes.value.usage).toEqual({
        input: 50,
        output: 25,
        cacheRead: 10,
        cacheWrite: 5,
        cost: 0.037,
        turns: 2,
      });
      expect(usageRes.value.ordinal).toBe(1);
    }

    const badUsage = updateInstanceSelfUsage("r-success", {
      input: -1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    });
    expect(badUsage.ok).toBe(false);
    expect(queryInstanceUsage("r-success")?.instance.usage.input).toBe(50);

    const tSuccess = transitionInstanceStatus("r-success", "success", {
      endedAt: 1_450,
    });
    const tError = transitionInstanceStatus("r-error", "error", {
      durationMs: 300,
    });
    const tCancel = transitionInstanceStatus("r-cancelled", "cancelled", {
      endedAt: 1_250,
    });

    expect(tSuccess.ok && tSuccess.value.status).toBe("success");
    expect(tSuccess.ok && tSuccess.value.durationMs).toBe(450);
    expect(tSuccess.ok && tSuccess.value.ordinal).toBe(1);

    expect(tError.ok && tError.value.status).toBe("error");
    expect(tError.ok && tError.value.durationMs).toBe(300);

    expect(tCancel.ok && tCancel.value.status).toBe("cancelled");
    expect(tCancel.ok && tCancel.value.durationMs).toBe(50);

    const doubleTransition = transitionInstanceStatus("r-success", "error", {
      durationMs: 999,
    });
    expect(doubleTransition.ok).toBe(false);
    expect(queryInstanceUsage("r-success")?.instance.status).toBe("success");
    expect(queryInstanceUsage("r-success")?.instance.durationMs).toBe(450);
  });

  test("replaces child subtrees idempotently while preserving siblings and spawner ordinals", () => {
    registerRootInstance({
      id: "root-1",
      agent: "planner",
      instanceName: "able-cedar",
      startedAt: 1_000,
    });
    updateInstanceSelfUsage("root-1", makeUsage({ input: 10, turns: 1 }));

    attachChildSubtree(
      "root-1",
      makeBoundaryNode({
        id: "child-a",
        agent: "explorer",
        instanceName: "swift-fox",
        ordinal: 1,
        startedAt: 1_100,
      }),
    );
    attachChildSubtree(
      "root-1",
      makeBoundaryNode({
        id: "child-b",
        agent: "explorer",
        instanceName: "brisk-owl",
        ordinal: 2,
        startedAt: 1_200,
      }),
    );

    const omittedGrandchild = {
      count: 1,
      totals: {
        instances: 1,
        statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
        usage: makeUsage({ input: 40, output: 10, cost: 0.04, turns: 1 }),
        durationMs: 150,
        byAgent: {
          worker: {
            instances: 1,
            statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
            usage: makeUsage({ input: 40, output: 10, cost: 0.04, turns: 1 }),
            durationMs: 150,
          },
        },
      },
    };

    const replacementB = makeBoundaryNode({
      id: "child-b",
      agent: "explorer",
      instanceName: "brisk-owl",
      ordinal: 1,
      startedAt: 1_200,
      status: "success",
      durationMs: 300,
      usage: makeUsage({ input: 20, output: 5, cost: 0.02, turns: 1 }),
      omitted: omittedGrandchild,
      children: [
        makeBoundaryNode({
          id: "grandchild-1",
          agent: "worker",
          instanceName: "kind-wren",
          ordinal: 1,
          startedAt: 1_250,
          status: "success",
          durationMs: 100,
          usage: makeUsage({ input: 30, output: 15, cost: 0.03, turns: 1 }),
        }),
      ],
    });

    const firstAttach = attachChildSubtree("root-1", replacementB);
    expect(firstAttach.ok).toBe(true);
    expect(firstAttach.ok && firstAttach.value.ordinal).toBe(2);

    const afterFirst = queryRootRunUsage("root-1");
    expect(afterFirst?.rollup.instances).toBe(5);
    expect(afterFirst?.rollup.usage.input).toBe(100);
    expect(afterFirst?.rollup.durationMs).toBe(550);

    const secondAttach = attachChildSubtree("root-1", replacementB);
    expect(secondAttach.ok).toBe(true);
    const afterSecond = queryRootRunUsage("root-1");
    expect(afterSecond?.rollup).toEqual(afterFirst?.rollup);
    expect(afterSecond?.run.children.map((c) => c.id)).toEqual([
      "child-a",
      "child-b",
    ]);
  });

  test("retains initially attached subtree ordinals when a received subtree is replaced", () => {
    registerRootInstance({
      id: "root-attached",
      agent: "planner",
      instanceName: "able-cedar",
      startedAt: 1_000,
    });

    const received = makeBoundaryNode({
      id: "child-received",
      agent: "explorer",
      instanceName: "swift-fox",
      ordinal: 3,
      startedAt: 2_000,
      children: [
        makeBoundaryNode({
          id: "grandchild-received",
          agent: "worker",
          instanceName: "kind-wren",
          ordinal: 2,
          startedAt: 2_100,
        }),
      ],
    });
    const firstAttach = attachChildSubtree("root-attached", received);
    expect(firstAttach.ok && firstAttach.value.ordinal).toBe(3);

    const replacement = makeBoundaryNode({
      id: "child-received",
      agent: "explorer",
      instanceName: "swift-fox",
      ordinal: 7,
      startedAt: 2_000,
      status: "success",
      durationMs: 50,
      children: [
        makeBoundaryNode({
          id: "grandchild-received",
          agent: "worker",
          instanceName: "kind-wren",
          ordinal: 9,
          startedAt: 2_100,
          status: "success",
          durationMs: 20,
        }),
        makeBoundaryNode({
          id: "grandchild-new",
          agent: "worker",
          instanceName: "novel-wren",
          ordinal: 5,
          startedAt: 2_200,
        }),
      ],
    });

    expect(attachChildSubtree("root-attached", replacement).ok).toBe(true);
    expect(queryInstanceUsage("child-received")?.instance.ordinal).toBe(3);
    expect(queryInstanceUsage("grandchild-received")?.instance.ordinal).toBe(2);
    expect(queryInstanceUsage("grandchild-new")?.instance.ordinal).toBe(5);
  });

  test("rejects attached subtrees carrying unrepresentable ordinals", () => {
    registerRootInstance({
      id: "root-unsafe",
      agent: "explorer",
      instanceName: "able-cedar",
      startedAt: 1_000,
    });

    const unsafe = attachChildSubtree(
      "root-unsafe",
      makeBoundaryNode({
        id: "child-unsafe",
        agent: "explorer",
        instanceName: "swift-fox",
        ordinal: Number.MAX_SAFE_INTEGER + 1,
        startedAt: 1_100,
        status: "success",
        durationMs: 100,
      }),
    );
    expect(unsafe.ok).toBe(false);
  });

  test("rejects invalid or colliding boundary subtrees without corrupting accepted state", () => {
    registerRootInstance({
      id: "root-1",
      agent: "planner",
      instanceName: "able-cedar",
      startedAt: 1_000,
    });
    registerRootInstance({
      id: "root-2",
      agent: "planner",
      instanceName: "other-cedar",
      startedAt: 1_050,
    });
    updateInstanceSelfUsage("root-1", makeUsage({ input: 77, turns: 1 }));
    attachChildSubtree(
      "root-1",
      makeBoundaryNode({
        id: "sibling-a",
        agent: "explorer",
        instanceName: "swift-fox",
        startedAt: 1_100,
      }),
    );

    const cyclic = makeBoundaryNode({ id: "child-bad" });
    cyclic.children.push(cyclic);
    expect(attachChildSubtree("root-1", cyclic).ok).toBe(false);

    const duplicateWithParent = makeBoundaryNode({
      id: "child-bad",
      children: [makeBoundaryNode({ id: "root-1" })],
    });
    expect(attachChildSubtree("root-1", duplicateWithParent).ok).toBe(false);

    const duplicateWithSibling = makeBoundaryNode({
      id: "child-bad",
      children: [makeBoundaryNode({ id: "sibling-a" })],
    });
    expect(attachChildSubtree("root-1", duplicateWithSibling).ok).toBe(false);

    const duplicateWithOtherRoot = makeBoundaryNode({
      id: "child-bad",
      children: [makeBoundaryNode({ id: "root-2" })],
    });
    expect(attachChildSubtree("root-1", duplicateWithOtherRoot).ok).toBe(false);

    const sensitiveField = {
      ...makeBoundaryNode({ id: "child-bad" }),
      stderr: "secret stack",
    };
    expect(attachChildSubtree("root-1", sensitiveField).ok).toBe(false);

    const root1 = queryRootRunUsage("root-1");
    expect(root1?.run.usage.input).toBe(77);
    expect(root1?.run.children).toHaveLength(1);
    expect(root1?.run.children[0]?.id).toBe("sibling-a");
    expect(queryRootRunUsage("root-2")).toBeDefined();
  });

  test("restores terminal runs, skips duplicate and invalid entries, and advances ordinals beyond max", () => {
    const restoredRun1 = makeBoundaryNode({
      id: "hist-1",
      agent: "explorer",
      instanceName: "old-fox",
      ordinal: 5,
      startedAt: 500,
      status: "success",
      durationMs: 200,
      usage: makeUsage({ input: 40, output: 10, cost: 0.05, turns: 2 }),
    });
    const stillRunningInvalid = makeBoundaryNode({
      id: "hist-running",
      agent: "explorer",
      instanceName: "bad-fox",
      ordinal: 99,
      startedAt: 600,
      status: "running",
    });

    const res = restoreSessionRuns([
      restoredRun1,
      restoredRun1,
      stillRunningInvalid,
      { broken: true },
    ]);
    expect(res.restoredCount).toBe(1);
    expect(res.skippedCount).toBe(3);

    const sess = querySessionUsage();
    expect(sess.runs).toHaveLength(1);
    expect(sess.rollup.instances).toBe(1);
    expect(sess.rollup.usage.input).toBe(40);

    const nextLaunch = registerRootInstance({
      id: "new-launch",
      agent: "explorer",
      instanceName: "fresh-fox",
      startedAt: 2_000,
    });
    expect(nextLaunch.ok && nextLaunch.value.ordinal).toBe(6);
  });

  test("allocates root ordinals past a restored maximum and halts at the ceiling", () => {
    const restored = restoreSessionRuns([
      makeBoundaryNode({
        id: "hist-near-ceiling",
        agent: "explorer",
        instanceName: "old-fox",
        ordinal: Number.MAX_SAFE_INTEGER - 1,
        startedAt: 500,
        status: "success",
        durationMs: 100,
      }),
    ]);
    expect(restored.restoredCount).toBe(1);

    const atCeiling = registerRootInstance({
      id: "root-at-ceiling",
      agent: "explorer",
      instanceName: "fresh-fox",
      startedAt: 1_000,
    });
    expect(atCeiling.ok && atCeiling.value.ordinal).toBe(
      Number.MAX_SAFE_INTEGER,
    );

    const pastCeiling = registerRootInstance({
      id: "root-past-ceiling",
      agent: "explorer",
      instanceName: "later-fox",
      startedAt: 1_100,
    });
    expect(pastCeiling.ok).toBe(false);
    expect(queryRootRunUsage("root-past-ceiling")).toBeUndefined();
  });

  test("skips restored runs that duplicate identities already accounted", () => {
    const result = restoreSessionRuns([
      makeBoundaryNode({
        id: "hist-1",
        agent: "explorer",
        instanceName: "old-fox",
        status: "success",
        durationMs: 10,
        children: [
          makeBoundaryNode({
            id: "hist-shared",
            agent: "worker",
            instanceName: "shared-wren",
            status: "success",
            durationMs: 10,
          }),
        ],
      }),
      makeBoundaryNode({
        id: "hist-2",
        agent: "explorer",
        instanceName: "new-fox",
        status: "success",
        durationMs: 10,
        children: [
          makeBoundaryNode({
            id: "hist-shared",
            agent: "worker",
            instanceName: "shared-wren",
            status: "success",
            durationMs: 10,
          }),
        ],
      }),
    ]);

    expect(result).toEqual({ restoredCount: 1, skippedCount: 1 });
    const session = querySessionUsage();
    expect(session.runs.map((run) => run.id)).toEqual(["hist-1"]);
    expect(session.rollup.instances).toBe(2);
  });

  test("skips restored runs that duplicate identities in live subtrees", () => {
    registerRootInstance({
      id: "live-root",
      agent: "explorer",
      instanceName: "live-fox",
      startedAt: 1_000,
    });
    attachChildSubtree(
      "live-root",
      makeBoundaryNode({
        id: "live-child",
        agent: "explorer",
        instanceName: "live-wren",
        startedAt: 1_100,
      }),
    );

    const result = restoreSessionRuns([
      makeBoundaryNode({
        id: "hist-ok",
        agent: "worker",
        instanceName: "new-owl",
        status: "success",
        durationMs: 10,
      }),
      makeBoundaryNode({
        id: "hist-collide",
        agent: "worker",
        instanceName: "old-owl",
        status: "success",
        durationMs: 10,
        children: [
          makeBoundaryNode({
            id: "live-child",
            agent: "explorer",
            instanceName: "live-wren",
            status: "success",
            durationMs: 10,
          }),
        ],
      }),
    ]);

    expect(result).toEqual({ restoredCount: 1, skippedCount: 1 });
    expect(querySessionUsage().rollup.instances).toBe(3);
  });

  test("rejects attached subtrees that duplicate restored identities", () => {
    const restored = restoreSessionRuns([
      makeBoundaryNode({
        id: "hist-root",
        agent: "explorer",
        instanceName: "old-fox",
        ordinal: 1,
        startedAt: 500,
        status: "success",
        durationMs: 200,
        children: [
          makeBoundaryNode({
            id: "hist-child",
            agent: "worker",
            instanceName: "old-wren",
            ordinal: 1,
            startedAt: 550,
            status: "success",
            durationMs: 20,
          }),
        ],
      }),
    ]);
    expect(restored).toEqual({ restoredCount: 1, skippedCount: 0 });

    registerRootInstance({
      id: "live-root",
      agent: "explorer",
      instanceName: "live-fox",
      startedAt: 1_000,
    });

    const colliding = attachChildSubtree(
      "live-root",
      makeBoundaryNode({
        id: "live-child",
        agent: "worker",
        instanceName: "live-wren",
        children: [
          makeBoundaryNode({
            id: "hist-child",
            agent: "worker",
            instanceName: "old-wren",
            ordinal: 2,
          }),
        ],
      }),
    );
    expect(colliding.ok).toBe(false);

    const accepted = attachChildSubtree(
      "live-root",
      makeBoundaryNode({
        id: "live-child",
        agent: "worker",
        instanceName: "live-wren",
      }),
    );
    expect(accepted.ok).toBe(true);

    expect(queryRootRunUsage("live-root")?.rollup.instances).toBe(2);
    expect(queryInstanceUsage("hist-child")?.instance.instanceName).toBe(
      "old-wren",
    );
    expect(querySessionUsage().rollup.instances).toBe(4);
  });

  test("rejects registered instances that reuse restored identities and keeps lookups unambiguous", () => {
    const restored = restoreSessionRuns([
      makeBoundaryNode({
        id: "dup",
        agent: "explorer",
        instanceName: "old-fox",
        ordinal: 1,
        startedAt: 500,
        status: "success",
        durationMs: 200,
        children: [
          makeBoundaryNode({
            id: "dup-child",
            agent: "worker",
            instanceName: "old-wren",
            ordinal: 1,
            startedAt: 550,
            status: "success",
            durationMs: 20,
          }),
        ],
      }),
    ]);
    expect(restored).toEqual({ restoredCount: 1, skippedCount: 0 });

    registerRootInstance({
      id: "live-root",
      agent: "planner",
      instanceName: "live-cedar",
      startedAt: 1_000,
    });

    expect(
      registerRootInstance({
        id: "dup",
        agent: "explorer",
        instanceName: "new-fox",
        startedAt: 1_000,
      }).ok,
    ).toBe(false);

    expect(querySessionUsage().runs.map((run) => run.id)).toEqual([
      "live-root",
      "dup",
    ]);

    const found = queryInstanceUsage("dup");
    expect(found?.instance.instanceName).toBe("old-fox");
    expect(found?.rollup.instances).toBe(2);
    expect(queryInstanceUsage("dup-child")?.instance.instanceName).toBe(
      "old-wren",
    );
  });

  test("queries session usage for instances whose agent name shadows prototype members", () => {
    registerRootInstance({
      id: "root-proto",
      agent: "__proto__",
      instanceName: "able-badger",
      startedAt: 1_000,
    });

    const session = querySessionUsage();
    expect(session.runs).toHaveLength(1);
    expect(session.rollup.byAgent[PROTO_AGENT]?.instances).toBe(1);
  });

  test("queries session most-recent-first, root by id or latest name, represented descendants, and hides omitted ids", () => {
    registerRootInstance({
      id: "run-older",
      agent: "explorer",
      instanceName: "shared-name",
      startedAt: 1_000,
    });
    registerRootInstance({
      id: "run-newer-same-ts-1",
      agent: "explorer",
      instanceName: "shared-name",
      startedAt: 2_000,
    });
    registerRootInstance({
      id: "run-newer-same-ts-2",
      agent: "worker",
      instanceName: "shared-name",
      startedAt: 2_000,
    });

    attachChildSubtree(
      "run-newer-same-ts-2",
      makeBoundaryNode({
        id: "nested-1",
        agent: "explorer",
        instanceName: "nested-fox",
        ordinal: 1,
        startedAt: 2_100,
        status: "success",
        durationMs: 50,
        usage: makeUsage({ input: 15, output: 5, cost: 0.01, turns: 1 }),
        omitted: {
          count: 1,
          totals: {
            instances: 1,
            statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
            usage: makeUsage({ input: 25, output: 10, cost: 0.02, turns: 1 }),
            durationMs: 75,
            byAgent: {
              explorer: {
                instances: 1,
                statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
                usage: makeUsage({
                  input: 25,
                  output: 10,
                  cost: 0.02,
                  turns: 1,
                }),
                durationMs: 75,
              },
            },
          },
        },
      }),
    );

    const sessionResult = querySessionUsage();
    expect(sessionResult.runs.map((r) => r.id)).toEqual([
      "run-newer-same-ts-2",
      "run-newer-same-ts-1",
      "run-older",
    ]);

    expect(queryRootRunUsage("run-older")?.run.id).toBe("run-older");
    expect(queryRootRunUsage("shared-name")?.run.id).toBe(
      "run-newer-same-ts-2",
    );
    expect(queryRootRunUsage("nested-1")).toBeUndefined();

    const nestedQuery = queryInstanceUsage("nested-1");
    expect(nestedQuery?.instance.id).toBe("nested-1");
    expect(nestedQuery?.rollup.instances).toBe(2);
    expect(nestedQuery?.rollup.usage.input).toBe(40);
    expect(queryInstanceUsage("omitted-id")).toBeUndefined();
  });

  test("returns deep-cloned immutable query results isolated from caller mutations", () => {
    registerRootInstance({
      id: "root-imm",
      agent: "explorer",
      instanceName: "solid-pine",
      startedAt: 1_000,
    });
    updateInstanceSelfUsage("root-imm", makeUsage({ input: 20, turns: 1 }));

    const s1 = querySessionUsage();
    if (s1.runs[0]) {
      s1.runs[0].usage.input = 9999;
      s1.runs[0].children.push(makeBoundaryNode({ id: "fake" }));
    }
    s1.rollup.instances = 999;

    const r1 = queryRootRunUsage("root-imm");
    if (r1) {
      r1.run.agent = "tampered";
      r1.rollup.usage.input = 8888;
    }

    const i1 = queryInstanceUsage("root-imm");
    if (i1) {
      i1.instance.instanceName = "tampered-name";
    }

    const fresh = querySessionUsage();
    expect(fresh.rollup.instances).toBe(1);
    expect(fresh.rollup.usage.input).toBe(20);
    expect(fresh.runs[0]?.usage.input).toBe(20);
    expect(fresh.runs[0]?.children).toHaveLength(0);
    expect(fresh.runs[0]?.agent).toBe("explorer");
    expect(fresh.runs[0]?.instanceName).toBe("solid-pine");
  });

  test("drops replaced grandchildren on wholesale replacement and isolates invalid inputs across queries", () => {
    registerRootInstance({
      id: "root-rep",
      agent: "planner",
      instanceName: "able-pine",
      startedAt: 1_000,
    });

    attachChildSubtree(
      "root-rep",
      makeBoundaryNode({
        id: "child-rep",
        agent: "explorer",
        instanceName: "swift-fox",
        ordinal: 1,
        startedAt: 1_100,
        usage: makeUsage({ input: 10, turns: 1 }),
        children: [
          makeBoundaryNode({
            id: "old-grandchild",
            agent: "worker",
            instanceName: "old-wren",
            ordinal: 1,
            startedAt: 1_150,
            usage: makeUsage({ input: 50, turns: 1 }),
          }),
        ],
      }),
    );

    expect(queryInstanceUsage("old-grandchild")).toBeDefined();

    attachChildSubtree(
      "root-rep",
      makeBoundaryNode({
        id: "child-rep",
        agent: "explorer",
        instanceName: "swift-fox",
        ordinal: 1,
        startedAt: 1_100,
        status: "success",
        durationMs: 200,
        usage: makeUsage({ input: 15, turns: 1 }),
        children: [],
      }),
    );

    expect(queryInstanceUsage("old-grandchild")).toBeUndefined();
    const afterReplace = queryRootRunUsage("root-rep");
    expect(afterReplace?.rollup.instances).toBe(2);
    expect(afterReplace?.rollup.usage.input).toBe(15);

    expect(
      registerRootInstance({
        id: "",
        agent: "explorer",
        instanceName: "x",
      }).ok,
    ).toBe(false);
    expect(
      registerRootInstance({
        id: "bad-start",
        agent: "explorer",
        instanceName: "x",
        startedAt: -5,
      }).ok,
    ).toBe(false);
    expect(updateInstanceSelfUsage("", makeUsage()).ok).toBe(false);
    expect(updateInstanceSelfUsage("missing-id", makeUsage()).ok).toBe(false);
    expect(attachChildSubtree("", makeBoundaryNode()).ok).toBe(false);
    expect(attachChildSubtree("missing-parent", makeBoundaryNode()).ok).toBe(
      false,
    );

    expect(
      transitionInstanceStatus("root-rep", "success", {
        durationMs: -1,
      }).ok,
    ).toBe(false);
    expect(
      transitionInstanceStatus("root-rep", "success", {
        endedAt: 500,
        usage: { ...makeUsage(), input: -10 },
      }).ok,
    ).toBe(false);
    expect(queryInstanceUsage("root-rep")?.instance.status).toBe("running");

    const clampTransition = transitionInstanceStatus("root-rep", "cancelled", {
      endedAt: 500,
      usage: makeUsage({ input: 33, turns: 1 }),
    });
    expect(clampTransition.ok).toBe(true);
    expect(clampTransition.ok && clampTransition.value.durationMs).toBe(0);
    expect(clampTransition.ok && clampTransition.value.usage.input).toBe(33);

    expect(queryRootRunUsage("")).toBeUndefined();
    expect(queryInstanceUsage("")).toBeUndefined();
    expect(queryRootRunUsage("root-rep")?.run.id).toBe("root-rep");
    expect(queryInstanceUsage("child-rep")?.instance.id).toBe("child-rep");
  });

  test("builds bounded snapshots without evicting in-memory descendants and reconciles terminal descendants", () => {
    registerRootInstance({
      id: "root-snap",
      agent: "planner",
      instanceName: "able-pine",
      startedAt: 1_000,
    });

    for (let i = 1; i <= 60; i++) {
      attachChildSubtree(
        "root-snap",
        makeBoundaryNode({
          id: `child-${i}`,
          agent: "explorer",
          instanceName: `child-${i}`,
          ordinal: i,
          startedAt: 1_000 + i * 10,
        }),
      );
      updateInstanceSelfUsage(
        `child-${i}`,
        makeUsage({ input: 10, output: 5, cost: 0.01, turns: 1 }),
      );
      if (i <= 20) {
        transitionInstanceStatus(`child-${i}`, "success", {
          endedAt: 1_000 + i * 10 + 50,
        });
      }
    }

    const bounded = snapshotInstanceUsage("root-snap");
    expect(bounded).toBeDefined();
    expect(bounded?.children).toHaveLength(49);
    expect(bounded?.omitted?.count).toBe(11);
    expect(bounded?.omitted?.totals.statuses.success).toBe(11);

    const fullQuery = queryRootRunUsage("root-snap");
    expect(fullQuery?.run.children).toHaveLength(60);
    expect(queryInstanceUsage("child-1")?.instance.id).toBe("child-1");

    const termRes = transitionInstanceStatus("root-snap", "cancelled", {
      endedAt: 3_000,
    });
    expect(termRes.ok).toBe(true);
    const terminalSnap = snapshotInstanceUsage("root-snap");
    expect(terminalSnap?.status).toBe("cancelled");
    expect(terminalSnap?.durationMs).toBe(2_000);
    expect(terminalSnap?.children.every((c) => c.status !== "running")).toBe(
      true,
    );
    expect(terminalSnap?.omitted?.totals.statuses.running).toBe(0);
    expect(queryInstanceUsage("child-60")?.instance.status).toBe("cancelled");
    expect(queryInstanceUsage("child-60")?.instance.durationMs).toBe(1_400);
    expect(snapshotInstanceUsage("missing-snap")).toBeUndefined();
  });

  test("reconciles running descendants without fabricated durations when transition provides only durationMs", () => {
    registerRootInstance({
      id: "root-dur-only",
      agent: "planner",
      instanceName: "able-pine",
      startedAt: 1_000,
    });
    attachChildSubtree(
      "root-dur-only",
      makeBoundaryNode({
        id: "child-dur-only",
        agent: "explorer",
        instanceName: "swift-fox",
        startedAt: 1_100,
      }),
    );

    const term = transitionInstanceStatus("root-dur-only", "error", {
      durationMs: 500,
    });
    expect(term.ok).toBe(true);
    const child = queryInstanceUsage("child-dur-only")?.instance;
    expect(child?.status).toBe("cancelled");
    expect(child?.durationMs).toBeUndefined();

    registerRootInstance({
      id: "root-both",
      agent: "planner",
      instanceName: "able-oak",
      startedAt: 1_000,
    });
    attachChildSubtree(
      "root-both",
      makeBoundaryNode({
        id: "child-both",
        agent: "explorer",
        instanceName: "swift-owl",
        startedAt: 1_100,
      }),
    );

    expect(
      transitionInstanceStatus("root-both", "success", {
        durationMs: 250,
        endedAt: -1,
      }).ok,
    ).toBe(false);
    expect(
      transitionInstanceStatus("root-both", "success", {
        durationMs: 250,
        endedAt: 1_400,
      }).ok,
    ).toBe(true);
    expect(snapshotInstanceUsage("child-both")).toEqual({
      id: "child-both",
      agent: "explorer",
      instanceName: "swift-owl",
      ordinal: 1,
      startedAt: 1_100,
      status: "cancelled",
      durationMs: 300,
      usage: createEmptyAdditiveUsage(),
      children: [],
    });
    expect(snapshotInstanceUsage("")).toBeUndefined();
  });

  test("restores a persisted run with descendants into a fresh ledger, as a forked session's instance does", () => {
    registerRootInstance({
      id: "orig-run",
      agent: "planner",
      instanceName: "able-pine",
      startedAt: 1_000,
    });
    attachChildSubtree(
      "orig-run",
      makeBoundaryNode({
        id: "orig-child",
        agent: "explorer",
        instanceName: "swift-fox",
        ordinal: 1,
        startedAt: 1_100,
        status: "success",
        durationMs: 50,
        usage: makeUsage({ input: 20, output: 10, cost: 0.02, turns: 1 }),
      }),
    );
    transitionInstanceStatus("orig-run", "success", { endedAt: 1_300 });
    const snapshot = snapshotInstanceUsage("orig-run");
    expect(snapshot).toBeDefined();

    resetUsageLedger();
    expect(restoreSessionRuns([snapshot])).toEqual({
      restoredCount: 1,
      skippedCount: 0,
    });
    const session = querySessionUsage();
    expect(session.runs.map((run) => run.id)).toEqual(["orig-run"]);
    expect(session.rollup.instances).toBe(2);
    expect(session.rollup.usage.input).toBe(20);
    expect(queryInstanceUsage("orig-child")?.instance.durationMs).toBe(50);
  });

  test("replaces previously restored runs when restore runs again", () => {
    const run = (id: string) =>
      makeBoundaryNode({
        id,
        agent: "explorer",
        instanceName: id,
        status: "success",
        durationMs: 10,
      });
    restoreSessionRuns([run("first")]);
    restoreSessionRuns([run("second")]);
    expect(querySessionUsage().runs.map((r) => r.id)).toEqual(["second"]);
  });

  test.each([
    {
      name: "empty instance ids",
      id: "",
      status: "success" as const,
      error: "Instance id must be a non-empty string.",
    },
    {
      name: "non-terminal statuses",
      id: "missing",
      status: "pending" as unknown as Exclude<AccountingStatus, "running">,
      error: 'Invalid terminal status "pending".',
    },
    {
      name: "unknown instance ids",
      id: "missing",
      status: "success" as const,
      error: 'Instance "missing" was not found.',
    },
  ])("transitionInstanceStatus rejects $name", ({ id, status, error }) => {
    expect(transitionInstanceStatus(id, status)).toEqual({ ok: false, error });
  });

  test("transitionInstanceStatus rejects invalid endedAt when durationMs is omitted", () => {
    registerRootInstance({
      id: "root-bad-ended",
      agent: "explorer",
      instanceName: "able-pine",
      startedAt: 1_000,
    });
    expect(
      transitionInstanceStatus("root-bad-ended", "success", { endedAt: -1 }),
    ).toEqual({
      ok: false,
      error: "Terminal endedAt must be a finite nonnegative number.",
    });
  });

  test("transitionInstanceStatus reconciles omitted aggregates to terminal statuses", () => {
    registerRootInstance({
      id: "root-omitted",
      agent: "planner",
      instanceName: "able-oak",
      startedAt: 1_000,
    });
    const attach = attachChildSubtree(
      "root-omitted",
      makeBoundaryNode({
        id: "omitted-child",
        ordinal: 1,
        startedAt: 1_100,
        status: "running",
        omitted: {
          count: 1,
          totals: {
            instances: 1,
            statuses: { running: 1, success: 0, error: 0, cancelled: 0 },
            usage: makeUsage(),
            durationMs: 0,
            byAgent: {
              explorer: {
                instances: 1,
                statuses: { running: 1, success: 0, error: 0, cancelled: 0 },
                usage: makeUsage(),
                durationMs: 0,
              },
            },
          },
        },
      }),
    );
    expect(attach.ok).toBe(true);

    const transition = transitionInstanceStatus("omitted-child", "success", {
      endedAt: 1_600,
    });
    expect(transition.ok).toBe(true);
    if (!transition.ok) return;
    expect(transition.value.durationMs).toBe(500);
    expect(transition.value.omitted?.totals.statuses).toEqual({
      running: 0,
      success: 0,
      error: 0,
      cancelled: 1,
    });
    expect(
      transition.value.omitted?.totals.byAgent["explorer"]?.statuses,
    ).toEqual({
      running: 0,
      success: 0,
      error: 0,
      cancelled: 1,
    });
    expect(
      queryInstanceUsage("omitted-child")?.instance.omitted?.totals.statuses
        .cancelled,
    ).toBe(1);
  });
});
