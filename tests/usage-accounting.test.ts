import { describe, expect, test } from "bun:test";
import type {
  AccountingRollup,
  AdditiveUsage,
  UsageInstanceNode,
} from "../src/shared/types.js";
import {
  cloneAccountingRollup,
  combineRollups,
  computeSubtreeRollup,
  createEmptyAdditiveUsage,
} from "../src/shared/usage-accounting.js";
import {
  MAX_USAGE_SNAPSHOT_NODES,
  reconcileTerminalDescendants,
  serializeUsageSnapshot,
} from "../src/shared/usage-snapshot.js";
import {
  validateSelfUsageFields,
  validateUsageTree,
} from "../src/shared/usage-validation.js";

const PROTO_AGENT = "__proto__";

function makeUsage(overrides: Partial<AdditiveUsage> = {}): AdditiveUsage {
  return {
    ...createEmptyAdditiveUsage(),
    ...overrides,
  };
}

function makeNode(
  overrides: Partial<UsageInstanceNode> = {},
): UsageInstanceNode {
  return {
    id: "req-1",
    agent: "explorer",
    instanceName: "swift-fox",
    ordinal: 1,
    startedAt: 1_000,
    status: "success",
    durationMs: 250,
    usage: makeUsage({ input: 10, output: 5, cost: 0.01, turns: 1 }),
    children: [],
    ...overrides,
  };
}

function makeValidOmitted(): NonNullable<UsageInstanceNode["omitted"]> {
  const explorerUsage = makeUsage({
    input: 100,
    output: 40,
    cacheRead: 20,
    cacheWrite: 10,
    cost: 0.1,
    turns: 2,
  });
  const workerUsage = makeUsage({
    input: 200,
    output: 80,
    cost: 0.2,
    turns: 3,
  });
  return {
    count: 3,
    totals: {
      instances: 3,
      statuses: { running: 1, success: 1, error: 1, cancelled: 0 },
      usage: makeUsage({
        input: 300,
        output: 120,
        cacheRead: 20,
        cacheWrite: 10,
        cost: 0.30000000000000004,
        turns: 5,
      }),
      durationMs: 900,
      byAgent: {
        explorer: {
          instances: 2,
          statuses: { running: 1, success: 1, error: 0, cancelled: 0 },
          usage: explorerUsage,
          durationMs: 400,
        },
        worker: {
          instances: 1,
          statuses: { running: 0, success: 0, error: 1, cancelled: 0 },
          usage: workerUsage,
          durationMs: 500,
        },
      },
    },
  };
}

describe("usage-accounting validation", () => {
  test("validates a valid terminal root with omitted totals", () => {
    const input = makeNode({
      omitted: makeValidOmitted(),
      children: [
        makeNode({
          id: "req-2",
          agent: "worker",
          instanceName: "keen-owl",
          ordinal: 1,
          startedAt: 1_100,
          status: "running",
          durationMs: undefined,
          usage: makeUsage({ input: 5, output: 2, turns: 1 }),
        }),
      ],
    });

    const result = validateUsageTree(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBe("req-1");
    expect(result.value.children).toHaveLength(1);
    expect(result.value.omitted?.count).toBe(3);

    input.usage.input = 9999;
    input.children.push(makeNode({ id: "req-mutated" }));
    expect(result.value.usage.input).toBe(10);
    expect(result.value.children).toHaveLength(1);
  });

  test("validates omitted with zero count when all totals are zero", () => {
    const input = makeNode({
      omitted: {
        count: 0,
        totals: {
          instances: 0,
          statuses: { running: 0, success: 0, error: 0, cancelled: 0 },
          usage: createEmptyAdditiveUsage(),
          durationMs: 0,
          byAgent: {},
        },
      },
    });
    const result = validateUsageTree(input);
    expect(result.ok).toBe(true);
  });

  test("rejects non-object and malformed primitive inputs", () => {
    for (const bad of [null, undefined, "str", 42, [], new Date()]) {
      const result = validateUsageTree(bad);
      expect(result.ok).toBe(false);
    }
  });

  test("rejects repeated node identities from cyclic or shared references", () => {
    const root = makeNode({ id: "root" });
    root.children.push(root);
    expect(validateUsageTree(root).ok).toBe(false);

    const sharedChild = makeNode({ id: "shared" });
    const parent = makeNode({
      id: "parent",
      children: [sharedChild, sharedChild],
    });
    expect(validateUsageTree(parent).ok).toBe(false);
  });

  test("rejects unknown and sensitive fields on nodes, usage, and omitted blocks", () => {
    const sensitiveCases: Record<string, unknown>[] = [
      { ...makeNode(), task: "secret task" },
      { ...makeNode(), stderr: "boom" },
      { ...makeNode(), messages: [] },
      { ...makeNode(), password: "123" },
      { ...makeNode(), token: "abc" },
      { ...makeNode(), extraField: true },
      { ...makeNode(), sessionId: "sess-1" },
      {
        ...makeNode(),
        usage: { ...makeUsage(), contextTokens: 100 },
      },
      {
        ...makeNode(),
        usage: { ...makeUsage(), contextWindowTokens: 200 },
      },
      {
        ...makeNode(),
        omitted: { ...makeValidOmitted(), extra: 1 },
      },
    ];

    for (const payload of sensitiveCases) {
      expect(validateUsageTree(payload).ok).toBe(false);
    }
  });

  test("rejects invalid identifiers, ordinals, timestamps, statuses, and durations", () => {
    const invalidNodes: unknown[] = [
      makeNode({ id: "" }),
      makeNode({ id: "   " }),
      makeNode({ agent: "" }),
      makeNode({ instanceName: "" }),
      makeNode({ ordinal: 0 }),
      makeNode({ ordinal: -1 }),
      makeNode({ ordinal: 1.5 }),
      makeNode({ ordinal: Number.MAX_SAFE_INTEGER + 1 }),
      makeNode({ startedAt: -1 }),
      makeNode({ startedAt: Number.NaN }),
      makeNode({ startedAt: Number.POSITIVE_INFINITY }),
      { ...makeNode(), status: "pending" },
      makeNode({ status: "running", durationMs: 10 }),
      makeNode({ status: "success", durationMs: -5 }),
      makeNode({ status: "error", durationMs: Number.NaN }),
      makeNode({ usage: makeUsage({ input: -1 }) }),
      makeNode({ usage: makeUsage({ cost: Number.POSITIVE_INFINITY }) }),
      makeNode({ usage: makeUsage({ turns: 1.25 }) }),
    ];

    for (const payload of invalidNodes) {
      expect(validateUsageTree(payload).ok).toBe(false);
    }
  });

  test("accepts the largest exactly representable instance ordinal", () => {
    const result = validateUsageTree(
      makeNode({ ordinal: Number.MAX_SAFE_INTEGER }),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.ordinal).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("rejects duplicate accounting identities within the tree", () => {
    const dupSibling = makeNode({
      id: "root",
      children: [makeNode({ id: "dup" }), makeNode({ id: "dup" })],
    });
    expect(validateUsageTree(dupSibling).ok).toBe(false);

    const dupDescendant = makeNode({
      id: "root",
      children: [
        makeNode({
          id: "child",
          children: [makeNode({ id: "root" })],
        }),
      ],
    });
    expect(validateUsageTree(dupDescendant).ok).toBe(false);
  });

  test("rejects inconsistent omitted counts, statuses, byAgent, usage, and durations", () => {
    const base = makeValidOmitted();

    const mismatchedCount = { ...base, count: 4 };
    expect(validateUsageTree(makeNode({ omitted: mismatchedCount })).ok).toBe(
      false,
    );

    const mismatchedStatuses = {
      ...base,
      totals: {
        ...base.totals,
        statuses: { running: 2, success: 1, error: 0, cancelled: 0 },
      },
    };
    expect(
      validateUsageTree(makeNode({ omitted: mismatchedStatuses })).ok,
    ).toBe(false);

    const mismatchedAgentCost = {
      ...base,
      totals: {
        ...base.totals,
        usage: { ...base.totals.usage, cost: 99 },
      },
    };
    expect(
      validateUsageTree(makeNode({ omitted: mismatchedAgentCost })).ok,
    ).toBe(false);

    const mismatchedAgentDuration = {
      ...base,
      totals: {
        ...base.totals,
        durationMs: 1234,
      },
    };
    expect(
      validateUsageTree(makeNode({ omitted: mismatchedAgentDuration })).ok,
    ).toBe(false);

    const zeroInstanceAgent = {
      ...base,
      totals: {
        ...base.totals,
        byAgent: {
          ...base.totals.byAgent,
          empty: {
            instances: 0,
            statuses: { running: 0, success: 0, error: 0, cancelled: 0 },
            usage: createEmptyAdditiveUsage(),
            durationMs: 0,
          },
        },
      },
    };
    expect(validateUsageTree(makeNode({ omitted: zeroInstanceAgent })).ok).toBe(
      false,
    );
  });

  test("rejects running nodes or running omitted counts when requireTerminal is set", () => {
    const runningNode = makeNode({ status: "running", durationMs: undefined });
    expect(validateUsageTree(runningNode, { requireTerminal: true }).ok).toBe(
      false,
    );

    const runningChild = makeNode({
      children: [
        makeNode({ id: "c1", status: "running", durationMs: undefined }),
      ],
    });
    expect(validateUsageTree(runningChild, { requireTerminal: true }).ok).toBe(
      false,
    );

    const runningOmitted = makeNode({ omitted: makeValidOmitted() });
    expect(
      validateUsageTree(runningOmitted, { requireTerminal: true }).ok,
    ).toBe(false);
  });

  const omittedBase = makeValidOmitted();

  test.each([
    {
      name: "node usage that is not a plain object",
      payload: { ...makeNode(), usage: null },
      error: "Usage must be a plain object.",
    },
    {
      name: "omitted statuses carrying disallowed fields",
      payload: {
        ...makeNode(),
        omitted: {
          ...omittedBase,
          totals: {
            ...omittedBase.totals,
            statuses: { ...omittedBase.totals.statuses, extra: 9 },
          },
        },
      },
      error: "Status counts contain disallowed fields.",
    },
    {
      name: "omitted statuses carrying non-integer counts",
      payload: {
        ...makeNode(),
        omitted: {
          ...omittedBase,
          totals: {
            ...omittedBase.totals,
            statuses: { ...omittedBase.totals.statuses, running: 1.5 },
          },
        },
      },
      error: "Status counts must be nonnegative integers.",
    },
    {
      name: "omitted byAgent entries that are not plain objects",
      payload: {
        ...makeNode(),
        omitted: {
          ...omittedBase,
          totals: { ...omittedBase.totals, byAgent: { explorer: null } },
        },
      },
      error: "Agent rollup must be a plain object.",
    },
    {
      name: "omitted byAgent entries carrying disallowed fields",
      payload: {
        ...makeNode(),
        omitted: {
          ...omittedBase,
          totals: {
            ...omittedBase.totals,
            byAgent: {
              explorer: { ...omittedBase.totals.byAgent["explorer"], extra: 1 },
            },
          },
        },
      },
      error: "Agent rollup contains disallowed fields.",
    },
    {
      name: "omitted byAgent entries carrying invalid durations",
      payload: {
        ...makeNode(),
        omitted: {
          ...omittedBase,
          totals: {
            ...omittedBase.totals,
            byAgent: {
              explorer: {
                ...omittedBase.totals.byAgent["explorer"],
                durationMs: -1,
              },
            },
          },
        },
      },
      error: "Agent rollup durationMs must be a finite nonnegative number.",
    },
    {
      name: "omitted totals carrying disallowed fields",
      payload: {
        ...makeNode(),
        omitted: {
          ...omittedBase,
          totals: { ...omittedBase.totals, extra: 1 },
        },
      },
      error: "Omitted totals contain disallowed fields.",
    },
    {
      name: "omitted statuses that do not sum to the omitted count",
      payload: {
        ...makeNode(),
        omitted: {
          ...omittedBase,
          totals: {
            ...omittedBase.totals,
            statuses: { running: 1, success: 1, error: 0, cancelled: 0 },
          },
        },
      },
      error: "Omitted status counts do not sum to omitted count.",
    },
  ])("rejects $name", ({ payload, error }) => {
    expect(validateUsageTree(payload)).toEqual({ ok: false, error });
  });
});

describe("usage-accounting rollups", () => {
  test("computes exact subtree rollups across self, children, and omitted totals", () => {
    const tree = makeNode({
      id: "root",
      agent: "planner",
      status: "success",
      durationMs: 100,
      usage: makeUsage({ input: 10, output: 5, cost: 0.01, turns: 1 }),
      omitted: makeValidOmitted(),
      children: [
        makeNode({
          id: "c1",
          agent: "explorer",
          status: "running",
          durationMs: undefined,
          usage: makeUsage({ input: 20, output: 10, cost: 0.02, turns: 1 }),
        }),
        makeNode({
          id: "c2",
          agent: "worker",
          status: "cancelled",
          durationMs: undefined,
          usage: makeUsage({ input: 30, output: 15, cost: 0.03, turns: 1 }),
        }),
      ],
    });

    const rollup = computeSubtreeRollup(tree);
    expect(rollup.instances).toBe(6);
    expect(rollup.statuses).toEqual({
      running: 2,
      success: 2,
      error: 1,
      cancelled: 1,
    });
    expect(rollup.usage.input).toBe(360);
    expect(rollup.usage.output).toBe(150);
    expect(rollup.usage.cacheRead).toBe(20);
    expect(rollup.usage.cacheWrite).toBe(10);
    expect(rollup.usage.turns).toBe(8);
    expect(rollup.usage.cost).toBeCloseTo(0.36, 12);
    expect(rollup.durationMs).toBe(1000);

    expect(rollup.byAgent["planner"]).toEqual({
      instances: 1,
      statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
      usage: makeUsage({ input: 10, output: 5, cost: 0.01, turns: 1 }),
      durationMs: 100,
    });
    expect(rollup.byAgent["explorer"]?.instances).toBe(3);
    expect(rollup.byAgent["explorer"]?.statuses).toEqual({
      running: 2,
      success: 1,
      error: 0,
      cancelled: 0,
    });
    expect(rollup.byAgent["explorer"]?.durationMs).toBe(400);
    expect(rollup.byAgent["worker"]?.instances).toBe(2);
    expect(rollup.byAgent["worker"]?.statuses).toEqual({
      running: 0,
      success: 0,
      error: 1,
      cancelled: 1,
    });
    expect(rollup.byAgent["worker"]?.durationMs).toBe(500);
  });

  test("combines multiple rollups without double counting", () => {
    const r1: AccountingRollup = computeSubtreeRollup(
      makeNode({ id: "a", agent: "explorer", durationMs: 120 }),
    );
    const r2: AccountingRollup = computeSubtreeRollup(
      makeNode({
        id: "b",
        agent: "explorer",
        status: "error",
        durationMs: 80,
      }),
    );

    const combined = combineRollups([r1, r2]);
    expect(combined.instances).toBe(2);
    expect(combined.statuses).toEqual({
      running: 0,
      success: 1,
      error: 1,
      cancelled: 0,
    });
    expect(combined.durationMs).toBe(200);
    expect(combined.byAgent["explorer"]?.instances).toBe(2);
    expect(combined.byAgent["explorer"]?.durationMs).toBe(200);
  });

  test("aggregates agent names that shadow object prototype members", () => {
    const tree = makeNode({
      id: "proto-root",
      agent: "__proto__",
      children: [
        makeNode({ id: "proto-child", agent: "constructor", ordinal: 1 }),
      ],
    });

    const rollup = computeSubtreeRollup(tree);
    expect(rollup.instances).toBe(2);
    expect(rollup.byAgent[PROTO_AGENT]?.instances).toBe(1);
    expect(rollup.byAgent[PROTO_AGENT]?.usage).toEqual(tree.usage);
    expect(rollup.byAgent["constructor"]?.instances).toBe(1);

    const combined = combineRollups([rollup, rollup]);
    expect(combined.byAgent[PROTO_AGENT]?.instances).toBe(2);
    expect(combined.byAgent["constructor"]?.instances).toBe(2);
  });

  test("merges omitted agent rollups named after object prototype members", () => {
    const omittedUsage = makeUsage({
      input: 40,
      output: 10,
      cost: 0.04,
      turns: 1,
    });
    const omittedAgentRollup = {
      instances: 1,
      statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
      usage: omittedUsage,
      durationMs: 150,
    };

    const result = validateUsageTree(
      makeNode({
        id: "proto-omitted-root",
        agent: "planner",
        omitted: {
          count: 1,
          totals: {
            instances: 1,
            statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
            usage: makeUsage({
              input: 40,
              output: 10,
              cost: 0.04,
              turns: 1,
            }),
            durationMs: 150,
            byAgent: { ["__proto__"]: omittedAgentRollup },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.omitted?.totals.byAgent[PROTO_AGENT]).toEqual(
      omittedAgentRollup,
    );
    const rollup = computeSubtreeRollup(result.value);
    expect(rollup.byAgent[PROTO_AGENT]).toEqual(omittedAgentRollup);
    expect(rollup.byAgent["planner"]?.instances).toBe(1);
  });

  test("rejects malformed omitted structures, children shapes, and invalid self usage fields", () => {
    const base = makeValidOmitted();
    const malformedCases: unknown[] = [
      { ...makeNode(), children: "not-an-array" },
      { ...makeNode(), omitted: "not-an-object" },
      { ...makeNode(), omitted: { count: -1, totals: base.totals } },
      { ...makeNode(), omitted: { count: 3, totals: "bad" } },
      {
        ...makeNode(),
        omitted: { count: 3, totals: { ...base.totals, instances: 2 } },
      },
      {
        ...makeNode(),
        omitted: { count: 3, totals: { ...base.totals, statuses: "bad" } },
      },
      {
        ...makeNode(),
        omitted: { count: 3, totals: { ...base.totals, durationMs: -1 } },
      },
      {
        ...makeNode(),
        omitted: { count: 3, totals: { ...base.totals, byAgent: [] } },
      },
      {
        ...makeNode(),
        omitted: {
          count: 3,
          totals: {
            ...base.totals,
            byAgent: { "": base.totals.byAgent["explorer"] },
          },
        },
      },
      {
        ...makeNode(),
        omitted: {
          count: 3,
          totals: {
            ...base.totals,
            byAgent: {
              ...base.totals.byAgent,
              explorer: {
                ...base.totals.byAgent["explorer"],
                statuses: { running: 9, success: 0, error: 0, cancelled: 0 },
              },
            },
          },
        },
      },
    ];

    for (const payload of malformedCases) {
      expect(validateUsageTree(payload).ok).toBe(false);
    }

    expect(validateSelfUsageFields(null).ok).toBe(false);
    expect(validateSelfUsageFields({ input: Number.NaN }).ok).toBe(false);
  });

  test("clones rollups deeply without sharing nested agent or usage objects", () => {
    const rollup = computeSubtreeRollup(
      makeNode({ id: "clone-root", agent: "explorer", durationMs: 50 }),
    );
    const cloned = cloneAccountingRollup(rollup);
    cloned.statuses.success = 99;
    cloned.usage.input = 999;
    if (cloned.byAgent["explorer"]) {
      cloned.byAgent["explorer"].durationMs = 777;
    }

    expect(rollup.statuses.success).toBe(1);
    expect(rollup.usage.input).toBe(10);
    expect(rollup.byAgent["explorer"]?.durationMs).toBe(50);
  });
});

function expectRollupMatches(
  actual: AccountingRollup,
  expected: AccountingRollup,
): void {
  expect(actual.instances).toBe(expected.instances);
  expect(actual.statuses).toEqual(expected.statuses);
  expect(actual.usage.input).toBe(expected.usage.input);
  expect(actual.usage.output).toBe(expected.usage.output);
  expect(actual.usage.cacheRead).toBe(expected.usage.cacheRead);
  expect(actual.usage.cacheWrite).toBe(expected.usage.cacheWrite);
  expect(actual.usage.turns).toBe(expected.usage.turns);
  expect(actual.usage.cost).toBeCloseTo(expected.usage.cost, 12);
  expect(actual.durationMs).toBeCloseTo(expected.durationMs, 12);

  expect(Object.keys(actual.byAgent).sort()).toEqual(
    Object.keys(expected.byAgent).sort(),
  );
  for (const agent of Object.keys(expected.byAgent)) {
    const actualEntry = actual.byAgent[agent];
    const expectedEntry = expected.byAgent[agent];
    if (!actualEntry || !expectedEntry) {
      throw new Error(`Missing agent rollup entry for ${agent}`);
    }
    expect(actualEntry.instances).toBe(expectedEntry.instances);
    expect(actualEntry.statuses).toEqual(expectedEntry.statuses);
    expect(actualEntry.usage.input).toBe(expectedEntry.usage.input);
    expect(actualEntry.usage.output).toBe(expectedEntry.usage.output);
    expect(actualEntry.usage.cacheRead).toBe(expectedEntry.usage.cacheRead);
    expect(actualEntry.usage.cacheWrite).toBe(expectedEntry.usage.cacheWrite);
    expect(actualEntry.usage.turns).toBe(expectedEntry.usage.turns);
    expect(actualEntry.usage.cost).toBeCloseTo(expectedEntry.usage.cost, 12);
    expect(actualEntry.durationMs).toBeCloseTo(expectedEntry.durationMs, 12);
  }
}

function countExplicitNodes(node: UsageInstanceNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countExplicitNodes(child);
  }
  return count;
}

describe("usage-accounting bounded snapshot serialization", () => {
  test("preserves full tree untouched when node count is within 50 nodes", () => {
    const children = Array.from({ length: 10 }, (_, idx) =>
      makeNode({
        id: `c-${idx + 1}`,
        agent: idx % 2 === 0 ? "explorer" : "worker",
        instanceName: `child-${idx + 1}`,
        ordinal: idx + 1,
        startedAt: 2_000 + idx,
        status: idx === 0 ? "running" : "success",
        durationMs: idx === 0 ? undefined : 100 + idx,
      }),
    );
    const root = makeNode({
      id: "root-small",
      status: "running",
      durationMs: undefined,
      children,
    });

    const snapshot = serializeUsageSnapshot(root);
    expect(MAX_USAGE_SNAPSHOT_NODES).toBe(50);
    expect(countExplicitNodes(snapshot)).toBe(11);
    expect(snapshot.omitted).toBeUndefined();
    expectRollupMatches(
      computeSubtreeRollup(snapshot),
      computeSubtreeRollup(root),
    );

    snapshot.usage.input = 9999;
    snapshot.children[0]?.children.push(makeNode({ id: "mutated" }));
    expect(root.usage.input).toBe(10);
    expect(root.children[0]?.children).toHaveLength(0);
  });

  test("caps wide trees at 50 explicit nodes, prioritizes running then recency, and folds removed rollups", () => {
    const children: UsageInstanceNode[] = [];
    for (let i = 1; i <= 40; i++) {
      children.push(
        makeNode({
          id: `done-${i}`,
          agent: i % 2 === 0 ? "worker" : "explorer",
          instanceName: `done-${i}`,
          ordinal: i,
          startedAt: 10_000 + i,
          status: i % 3 === 0 ? "error" : "success",
          durationMs: 100,
          usage: makeUsage({ input: 10, output: 5, cost: 0.01, turns: 1 }),
        }),
      );
    }
    for (let i = 1; i <= 25; i++) {
      children.push(
        makeNode({
          id: `run-${i}`,
          agent: i === 1 ? PROTO_AGENT : "explorer",
          instanceName: `run-${i}`,
          ordinal: 40 + i,
          startedAt: 1_000 + i,
          status: "running",
          durationMs: undefined,
          usage: makeUsage({ input: 20, output: 10, cost: 0.02, turns: 1 }),
        }),
      );
    }
    const root = makeNode({
      id: "root-wide",
      agent: "planner",
      startedAt: 500,
      status: "running",
      durationMs: undefined,
      children,
    });

    const snapshot = serializeUsageSnapshot(root);
    expect(countExplicitNodes(snapshot)).toBe(50);
    expect(validateUsageTree(snapshot).ok).toBe(true);
    expectRollupMatches(
      computeSubtreeRollup(snapshot),
      computeSubtreeRollup(root),
    );

    const retainedIds = new Set(snapshot.children.map((c) => c.id));
    for (let i = 1; i <= 25; i++) {
      expect(retainedIds.has(`run-${i}`)).toBe(true);
    }
    for (let i = 17; i <= 40; i++) {
      expect(retainedIds.has(`done-${i}`)).toBe(true);
    }
    for (let i = 1; i <= 16; i++) {
      expect(retainedIds.has(`done-${i}`)).toBe(false);
    }
    expect(snapshot.omitted?.count).toBe(16);
    expect(snapshot.omitted?.totals.instances).toBe(16);
    expect(root.children).toHaveLength(65);
    expect(root.omitted).toBeUndefined();
  });

  test("enforces 50-node cap when more than 50 descendants are running", () => {
    const runningChildren = Array.from({ length: 70 }, (_, idx) =>
      makeNode({
        id: `run-${idx + 1}`,
        agent: "worker",
        instanceName: `run-${idx + 1}`,
        ordinal: idx + 1,
        startedAt: 1_000 + idx,
        status: "running",
        durationMs: undefined,
        usage: makeUsage({ input: 5, output: 2, cost: 0.005, turns: 1 }),
      }),
    );
    const root = makeNode({
      id: "root-run-overflow",
      status: "running",
      durationMs: undefined,
      children: runningChildren,
    });

    const snapshot = serializeUsageSnapshot(root);
    expect(countExplicitNodes(snapshot)).toBe(50);
    expect(snapshot.children).toHaveLength(49);
    expect(snapshot.children.map((c) => c.id)).toEqual(
      Array.from({ length: 49 }, (_, idx) => `run-${idx + 22}`),
    );
    expect(snapshot.omitted?.count).toBe(21);
    expect(snapshot.omitted?.totals.statuses.running).toBe(21);
    expectRollupMatches(
      computeSubtreeRollup(snapshot),
      computeSubtreeRollup(root),
    );
    expect(validateUsageTree(snapshot).ok).toBe(true);
  });

  test("accounts ancestor budget so overlong ancestry never bypasses the 50-node cap", () => {
    let deepChain: UsageInstanceNode = makeNode({
      id: "deep-leaf-running",
      agent: "worker",
      instanceName: "deep-leaf",
      ordinal: 1,
      startedAt: 99_999,
      status: "running",
      durationMs: undefined,
      usage: makeUsage({ input: 50, output: 25, cost: 0.05, turns: 2 }),
    });
    for (let depth = 55; depth >= 1; depth--) {
      deepChain = makeNode({
        id: `chain-${depth}`,
        agent: "explorer",
        instanceName: `chain-${depth}`,
        ordinal: 1,
        startedAt: 100 + depth,
        status: "success",
        durationMs: 10,
        usage: makeUsage({ input: 1, output: 1, cost: 0.001, turns: 1 }),
        children: [deepChain],
      });
    }
    const shallowRunning = makeNode({
      id: "shallow-running",
      agent: "worker",
      instanceName: "shallow-running",
      ordinal: 2,
      startedAt: 5_000,
      status: "running",
      durationMs: undefined,
      usage: makeUsage({ input: 15, output: 5, cost: 0.02, turns: 1 }),
    });
    const root = makeNode({
      id: "root-overlong",
      startedAt: 50,
      status: "running",
      durationMs: undefined,
      children: [deepChain, shallowRunning],
    });

    const snapshot = serializeUsageSnapshot(root);
    expect(countExplicitNodes(snapshot)).toBeLessThanOrEqual(50);
    expect(countExplicitNodes(snapshot)).toBe(50);
    expect(validateUsageTree(snapshot).ok).toBe(true);
    expectRollupMatches(
      computeSubtreeRollup(snapshot),
      computeSubtreeRollup(root),
    );

    const rootChildIds = snapshot.children.map((c) => c.id);
    expect(rootChildIds).toContain("shallow-running");
    expect(rootChildIds).toContain("chain-1");

    let deepestRetained = snapshot.children.find((c) => c.id === "chain-1");
    let retainedChainDepth = 0;
    while (deepestRetained) {
      retainedChainDepth += 1;
      if (deepestRetained.children.length === 0) break;
      deepestRetained = deepestRetained.children[0];
    }
    if (!deepestRetained) {
      throw new Error("Expected retained chain node chain-48");
    }
    expect(retainedChainDepth).toBe(48);
    expect(deepestRetained.id).toBe("chain-48");
    expect(deepestRetained.omitted?.count).toBe(8);
    expect(deepestRetained.omitted?.totals.statuses.running).toBe(1);
    let originalChain48: UsageInstanceNode | undefined = deepChain;
    while (originalChain48 && originalChain48.id !== "chain-48") {
      originalChain48 = originalChain48.children[0];
    }
    if (!originalChain48) {
      throw new Error("Expected original chain-48 node");
    }
    expectRollupMatches(
      computeSubtreeRollup(deepestRetained),
      computeSubtreeRollup(originalChain48),
    );
  });

  test("breaks ties deterministically when running status and startedAt match", () => {
    const root = makeNode({
      id: "root-tie",
      startedAt: 1_000,
      status: "running",
      durationMs: undefined,
      children: [
        makeNode({
          id: "c-tie-2",
          ordinal: 2,
          startedAt: 2_000,
          status: "running",
          durationMs: undefined,
        }),
        makeNode({
          id: "c-tie-1",
          ordinal: 1,
          startedAt: 2_000,
          status: "running",
          durationMs: undefined,
          children: [
            makeNode({
              id: "g-tie-1",
              ordinal: 1,
              startedAt: 3_000,
              status: "running",
              durationMs: undefined,
            }),
          ],
        }),
      ],
    });

    const snap = serializeUsageSnapshot(root, { maxNodes: 3 });
    expect(countExplicitNodes(snap)).toBe(3);
    expect(snap.children.map((c) => c.id)).toEqual(["c-tie-1"]);
    expect(snap.children[0]?.children.map((c) => c.id)).toEqual(["g-tie-1"]);
    expect(snap.omitted?.count).toBe(1);
    expectRollupMatches(computeSubtreeRollup(snap), computeSubtreeRollup(root));
  });

  test("breaks final ties by visit order when depth, status, startedAt, and ordinal all match", () => {
    const root = makeNode({
      id: "root-order",
      startedAt: 1_000,
      status: "running",
      durationMs: undefined,
      children: [
        makeNode({
          id: "c-order-a",
          agent: "explorer",
          ordinal: 1,
          startedAt: 2_000,
          status: "running",
          durationMs: undefined,
        }),
        makeNode({
          id: "c-order-b",
          agent: "worker",
          ordinal: 1,
          startedAt: 2_000,
          status: "running",
          durationMs: undefined,
        }),
      ],
    });

    const snap = serializeUsageSnapshot(root, { maxNodes: 2 });
    expect(countExplicitNodes(snap)).toBe(2);
    expect(snap.children.map((c) => c.id)).toEqual(["c-order-a"]);
    expect(snap.omitted?.count).toBe(1);
    expectRollupMatches(computeSubtreeRollup(snap), computeSubtreeRollup(root));
  });

  test("merges pre-existing omitted aggregates with newly removed sibling subtrees at nearest retained ancestor", () => {
    const preOmitted = makeValidOmitted();
    const removedGrandchild = makeNode({
      id: "grand-removed",
      agent: "worker",
      instanceName: "grand-removed",
      ordinal: 1,
      startedAt: 1_050,
      status: "success",
      durationMs: 25,
      usage: makeUsage({ input: 12, output: 4, cost: 0.01, turns: 1 }),
      omitted: {
        count: 1,
        totals: {
          instances: 1,
          statuses: { running: 0, success: 0, error: 1, cancelled: 0 },
          usage: makeUsage({ input: 8, output: 2, cost: 0.01, turns: 1 }),
          durationMs: 40,
          byAgent: {
            explorer: {
              instances: 1,
              statuses: { running: 0, success: 0, error: 1, cancelled: 0 },
              usage: makeUsage({ input: 8, output: 2, cost: 0.01, turns: 1 }),
              durationMs: 40,
            },
          },
        },
      },
    });
    const keptChild = makeNode({
      id: "kept-child",
      agent: "planner",
      instanceName: "kept-child",
      ordinal: 1,
      startedAt: 2_000,
      status: "running",
      durationMs: undefined,
      omitted: preOmitted,
      children: [
        removedGrandchild,
        makeNode({
          id: "grand-kept",
          agent: "worker",
          instanceName: "grand-kept",
          ordinal: 2,
          startedAt: 3_000,
          status: "running",
          durationMs: undefined,
        }),
      ],
    });
    const root = makeNode({
      id: "root-merge",
      startedAt: 1_000,
      status: "running",
      durationMs: undefined,
      children: [keptChild],
    });

    const snapshot = serializeUsageSnapshot(root, { maxNodes: 3 });
    expect(countExplicitNodes(snapshot)).toBe(3);
    const snapshotKeptChild = snapshot.children[0];
    if (!snapshotKeptChild) {
      throw new Error("Expected retained kept-child");
    }
    expect(snapshotKeptChild.id).toBe("kept-child");
    expect(snapshotKeptChild.children.map((c) => c.id)).toEqual(["grand-kept"]);
    expect(snapshotKeptChild.omitted?.count).toBe(5);
    expectRollupMatches(
      computeSubtreeRollup(snapshot),
      computeSubtreeRollup(root),
    );
    expectRollupMatches(
      computeSubtreeRollup(snapshotKeptChild),
      computeSubtreeRollup(keptChild),
    );
    expect(validateUsageTree(snapshot).ok).toBe(true);
  });

  test("never exceeds 50 explicit nodes when callers request a larger maxNodes", () => {
    const children = Array.from({ length: 60 }, (_, idx) =>
      makeNode({
        id: `oversized-${idx + 1}`,
        instanceName: `oversized-${idx + 1}`,
        ordinal: idx + 1,
        startedAt: 2_000 + idx,
        status: idx % 2 === 0 ? "running" : "success",
        durationMs: idx % 2 === 0 ? undefined : 100,
        usage: makeUsage({ input: 3, output: 2, cost: 0.003, turns: 1 }),
      }),
    );
    const root = makeNode({
      id: "root-oversized",
      startedAt: 1_000,
      status: "running",
      durationMs: undefined,
      children,
    });

    for (const maxNodes of [51, 100, 10_000]) {
      const snapshot = serializeUsageSnapshot(root, { maxNodes });
      expect(countExplicitNodes(snapshot)).toBe(MAX_USAGE_SNAPSHOT_NODES);
      expect(snapshot.id).toBe("root-oversized");
      expect(validateUsageTree(snapshot).ok).toBe(true);
      expectRollupMatches(
        computeSubtreeRollup(snapshot),
        computeSubtreeRollup(root),
      );
    }
  });

  test("retains required ancestors within 50 explicit nodes when callers request a larger maxNodes", () => {
    let deepChain: UsageInstanceNode = makeNode({
      id: "cap-leaf",
      instanceName: "cap-leaf",
      startedAt: 99_999,
      status: "running",
      durationMs: undefined,
    });
    for (let depth = 60; depth >= 1; depth--) {
      deepChain = makeNode({
        id: `cap-chain-${depth}`,
        instanceName: `cap-chain-${depth}`,
        startedAt: 100 + depth,
        durationMs: 10,
        children: [deepChain],
      });
    }
    const root = makeNode({
      id: "root-ancestor-cap",
      startedAt: 50,
      status: "running",
      durationMs: undefined,
      children: [deepChain],
    });

    const snapshot = serializeUsageSnapshot(root, { maxNodes: 100 });
    expect(countExplicitNodes(snapshot)).toBe(MAX_USAGE_SNAPSHOT_NODES);
    expect(validateUsageTree(snapshot).ok).toBe(true);
    expectRollupMatches(
      computeSubtreeRollup(snapshot),
      computeSubtreeRollup(root),
    );

    let retained: UsageInstanceNode | undefined = snapshot.children[0];
    let retainedDepth = 0;
    while (retained) {
      retainedDepth += 1;
      expect(retained.id).toBe(`cap-chain-${retainedDepth}`);
      if (retained.children.length === 0) break;
      retained = retained.children[0];
    }
    expect(retainedDepth).toBe(49);
    expect(retained?.omitted?.count).toBe(12);
  });

  test.each([0, -2, 1.5])("rejects maxNodes %p", (maxNodes) => {
    expect(() => serializeUsageSnapshot(makeNode(), { maxNodes })).toThrow(
      RangeError,
    );
  });

  test("emits only usage-node fields when the input node carries extras", () => {
    const withExtras = {
      ...makeNode({ children: [makeNode({ id: "child" })] }),
      task: "secret",
    } as unknown as UsageInstanceNode;
    const snapshot = serializeUsageSnapshot(withExtras);
    expect(snapshot).not.toHaveProperty("task");
    expect(validateUsageTree(snapshot).ok).toBe(true);
  });
});

describe("usage-accounting terminal descendant reconciliation", () => {
  test("transitions represented running descendants and omitted running counts to cancelled without fabricating omitted durations", () => {
    const tree = makeNode({
      id: "root-term",
      agent: "planner",
      startedAt: 1_000,
      status: "success",
      durationMs: 1_000,
      usage: makeUsage({ input: 10, output: 5, cost: 0.01, turns: 1 }),
      omitted: {
        count: 3,
        totals: {
          instances: 3,
          statuses: { running: 2, success: 1, error: 0, cancelled: 0 },
          usage: makeUsage({ input: 300, output: 100, cost: 0.3, turns: 4 }),
          durationMs: 250,
          byAgent: {
            [PROTO_AGENT]: {
              instances: 2,
              statuses: { running: 1, success: 1, error: 0, cancelled: 0 },
              usage: makeUsage({ input: 200, output: 60, cost: 0.2, turns: 3 }),
              durationMs: 250,
            },
            worker: {
              instances: 1,
              statuses: { running: 1, success: 0, error: 0, cancelled: 0 },
              usage: makeUsage({ input: 100, output: 40, cost: 0.1, turns: 1 }),
              durationMs: 0,
            },
          },
        },
      },
      children: [
        makeNode({
          id: "c-finished",
          agent: "explorer",
          startedAt: 1_100,
          status: "success",
          durationMs: 200,
          usage: makeUsage({ input: 20, output: 10, cost: 0.02, turns: 1 }),
          children: [
            makeNode({
              id: "g-running",
              agent: "worker",
              startedAt: 1_300,
              status: "running",
              durationMs: undefined,
              usage: makeUsage({ input: 15, output: 5, cost: 0.015, turns: 1 }),
            }),
          ],
        }),
        makeNode({
          id: "c-running-late",
          agent: "worker",
          startedAt: 2_200,
          status: "running",
          durationMs: undefined,
          usage: makeUsage({ input: 5, output: 2, cost: 0.005, turns: 1 }),
        }),
      ],
    });

    const reconciled = reconcileTerminalDescendants(tree, { endedAt: 2_000 });
    expect(reconciled.status).toBe("success");
    expect(reconciled.durationMs).toBe(1_000);

    const cFinished = reconciled.children[0];
    if (!cFinished) {
      throw new Error("Expected reconciled c-finished child");
    }
    expect(cFinished.status).toBe("success");
    expect(cFinished.durationMs).toBe(200);
    expect(cFinished.children[0]?.status).toBe("cancelled");
    expect(cFinished.children[0]?.durationMs).toBe(700);

    const cRunningLate = reconciled.children[1];
    if (!cRunningLate) {
      throw new Error("Expected reconciled c-running-late child");
    }
    expect(cRunningLate.status).toBe("cancelled");
    expect(cRunningLate.durationMs).toBe(0);

    expect(reconciled.omitted?.count).toBe(3);
    expect(reconciled.omitted?.totals.statuses).toEqual({
      running: 0,
      success: 1,
      error: 0,
      cancelled: 2,
    });
    expect(reconciled.omitted?.totals.durationMs).toBe(250);
    expect(reconciled.omitted?.totals.byAgent[PROTO_AGENT]?.statuses).toEqual({
      running: 0,
      success: 1,
      error: 0,
      cancelled: 1,
    });
    expect(reconciled.omitted?.totals.byAgent[PROTO_AGENT]?.durationMs).toBe(
      250,
    );
    expect(reconciled.omitted?.totals.byAgent["worker"]?.statuses).toEqual({
      running: 0,
      success: 0,
      error: 0,
      cancelled: 1,
    });
    expect(reconciled.omitted?.totals.byAgent["worker"]?.durationMs).toBe(0);

    expect(validateUsageTree(reconciled, { requireTerminal: true }).ok).toBe(
      true,
    );
    expect(tree.children[1]?.status).toBe("running");
    expect(tree.omitted?.totals.statuses.running).toBe(2);
  });

  test("omits computed duration on represented running descendants when endedAt is unknown", () => {
    const tree = makeNode({
      id: "root-no-end",
      status: "error",
      durationMs: 400,
      children: [
        makeNode({
          id: "c-running",
          status: "running",
          durationMs: undefined,
          startedAt: 1_200,
        }),
      ],
    });

    const reconciled = reconcileTerminalDescendants(tree);
    expect(reconciled.children[0]?.status).toBe("cancelled");
    expect(reconciled.children[0]?.durationMs).toBeUndefined();
    expect(validateUsageTree(reconciled, { requireTerminal: true }).ok).toBe(
      true,
    );
  });
});

describe("usage-accounting terminal snapshot reconciliation", () => {
  test("reconciles represented running descendants before publishing a terminal snapshot", () => {
    const root = makeNode({
      id: "root-terminal-snapshot",
      startedAt: 1_000,
      status: "success",
      durationMs: 1_000,
      children: [
        makeNode({
          id: "snap-finished",
          startedAt: 1_050,
          status: "success",
          durationMs: 300,
          children: [
            makeNode({
              id: "snap-grand-running",
              startedAt: 1_400,
              status: "running",
              durationMs: undefined,
              usage: makeUsage({ input: 4, output: 2, cost: 0.004, turns: 1 }),
            }),
          ],
        }),
        makeNode({
          id: "snap-running",
          startedAt: 1_200,
          status: "running",
          durationMs: undefined,
          usage: makeUsage({ input: 6, output: 3, cost: 0.006, turns: 2 }),
        }),
      ],
    });

    const snapshot = serializeUsageSnapshot(root);
    const finished = snapshot.children[0];
    const running = snapshot.children[1];
    if (!finished || !running) {
      throw new Error("Expected both terminal snapshot children");
    }
    expect(finished.status).toBe("success");
    expect(finished.durationMs).toBe(300);
    expect(finished.children[0]?.status).toBe("cancelled");
    expect(finished.children[0]?.durationMs).toBe(600);
    expect(running.status).toBe("cancelled");
    expect(running.durationMs).toBe(800);
    expect(validateUsageTree(snapshot, { requireTerminal: true }).ok).toBe(
      true,
    );

    const snapshotRollup = computeSubtreeRollup(snapshot);
    const rootRollup = computeSubtreeRollup(root);
    expect(snapshotRollup.instances).toBe(rootRollup.instances);
    expect(snapshotRollup.usage).toEqual(rootRollup.usage);
    expect(snapshotRollup.statuses).toEqual({
      running: 0,
      success: rootRollup.statuses.success,
      error: rootRollup.statuses.error,
      cancelled: rootRollup.statuses.cancelled + rootRollup.statuses.running,
    });
    expect(snapshot.usage).toEqual(root.usage);
    expect(root.children[1]?.status).toBe("running");
  });

  test("cancels running descendants without inventing durations when the terminal root has no reported duration", () => {
    const root = makeNode({
      id: "root-terminal-unknown-end",
      startedAt: 1_000,
      status: "error",
      durationMs: undefined,
      children: [
        makeNode({
          id: "unknown-end-running",
          startedAt: 1_200,
          status: "running",
          durationMs: undefined,
        }),
      ],
    });

    const snapshot = serializeUsageSnapshot(root);
    expect(snapshot.children[0]?.status).toBe("cancelled");
    expect(snapshot.children[0]?.durationMs).toBeUndefined();
    expect(validateUsageTree(snapshot, { requireTerminal: true }).ok).toBe(
      true,
    );
  });

  test("folds trimmed running descendants into cancelled aggregates without adding duration sums", () => {
    const children = Array.from({ length: 60 }, (_, idx) =>
      makeNode({
        id: `trim-run-${idx + 1}`,
        instanceName: `trim-run-${idx + 1}`,
        ordinal: idx + 1,
        startedAt: 1_100 + idx,
        status: "running",
        durationMs: undefined,
        usage: makeUsage({ input: 2, output: 1, cost: 0.002, turns: 1 }),
      }),
    );
    const root = makeNode({
      id: "root-terminal-trimmed",
      startedAt: 1_000,
      status: "success",
      durationMs: 500,
      children,
    });

    const snapshot = serializeUsageSnapshot(root);
    expect(countExplicitNodes(snapshot)).toBe(MAX_USAGE_SNAPSHOT_NODES);
    expect(snapshot.children).toHaveLength(49);
    expect(snapshot.children.every((c) => c.status === "cancelled")).toBe(true);
    const mostRecent = snapshot.children.find((c) => c.id === "trim-run-60");
    expect(mostRecent?.durationMs).toBe(500 - 159);
    expect(snapshot.children.every((c) => c.durationMs !== undefined)).toBe(
      true,
    );
    expect(snapshot.omitted?.count).toBe(11);
    expect(snapshot.omitted?.totals.statuses).toEqual({
      running: 0,
      success: 0,
      error: 0,
      cancelled: 11,
    });
    expect(snapshot.omitted?.totals.durationMs).toBe(0);
    const omittedUsage = snapshot.omitted?.totals.usage;
    expect(omittedUsage?.input).toBe(22);
    expect(omittedUsage?.output).toBe(11);
    expect(omittedUsage?.turns).toBe(11);
    expect(omittedUsage?.cost).toBeCloseTo(0.022, 12);
    expect(validateUsageTree(snapshot, { requireTerminal: true }).ok).toBe(
      true,
    );
  });

  test("keeps running descendants running in a live snapshot", () => {
    const root = makeNode({
      id: "root-live",
      startedAt: 1_000,
      status: "running",
      durationMs: undefined,
      children: [
        makeNode({
          id: "live-running",
          startedAt: 1_500,
          status: "running",
          durationMs: undefined,
        }),
        makeNode({ id: "live-finished", startedAt: 1_200, durationMs: 100 }),
      ],
    });

    const snapshot = serializeUsageSnapshot(root);
    expect(snapshot.children[0]?.status).toBe("running");
    expect(snapshot.children[0]?.durationMs).toBeUndefined();
    expect(snapshot.children[1]?.status).toBe("success");
    expect(snapshot.children[1]?.durationMs).toBe(100);
  });
});
