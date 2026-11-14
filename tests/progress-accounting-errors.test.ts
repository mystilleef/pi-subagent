import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import * as ledgerModule from "../src/orchestration/usage-ledger.js";
import type { SubagentTheme } from "../src/output/ui.js";
import type { UsageInstanceNode } from "../src/shared/types.js";

/**
 * Ledger request ids whose lookups fail. The real exports are captured before
 * the mock registers, so the mock delegates to them and stays inert for every
 * other id. Progress modules load dynamically in `beforeEach` after
 * registration, mirroring the module-mock pattern in `jobs-command-width`.
 */
const realLedger = { ...ledgerModule };
const failingIds = new Set<string>();
const queryFailure = new Error("usage ledger query failed");

mock.module("../src/orchestration/usage-ledger.js", () => ({
  ...realLedger,
  queryInstanceUsage: (requestId: string) => {
    if (failingIds.has(requestId)) throw queryFailure;
    return realLedger.queryInstanceUsage(requestId);
  },
}));

type ProgressModule = typeof import("../src/progress/progress.js");

let progress: ProgressModule;

const ROOT_INSTANCE = "root-run";

beforeEach(async () => {
  progress = await import("../src/progress/progress.js");
  realLedger.resetUsageLedger();
  progress.resetProgressStore();
  failingIds.clear();
});

afterEach(() => {
  failingIds.clear();
  realLedger.resetUsageLedger();
  progress.resetProgressStore();
});

function makeTheme(): SubagentTheme {
  return {
    fg: (_color: ThemeColor, text: string) => text,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => text,
  };
}

function setupRootWithChild(requestId: string): void {
  const registered = realLedger.registerRootInstance({
    id: requestId,
    agent: "build",
    instanceName: ROOT_INSTANCE,
    startedAt: 500,
  });
  expect(registered.ok).toBe(true);
  const attached = realLedger.attachChildSubtree(requestId, {
    id: `${requestId}-child`,
    agent: "explorer",
    instanceName: "able-fox",
    ordinal: 1,
    startedAt: 1000,
    status: "running",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      turns: 1,
    },
    children: [],
  } satisfies UsageInstanceNode);
  expect(attached.ok).toBe(true);
  progress.createProgressState(
    requestId,
    "build",
    "do the important task",
    ROOT_INSTANCE,
  );
}

function renderCard(requestId: string, expanded: boolean): string[] {
  const rendered = progress.renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId },
    },
    { expanded },
    makeTheme(),
  );
  if (!rendered) throw new Error(`progress card missing for ${requestId}`);
  return rendered.render(120);
}

test("renders ledger tally while ledger lookups succeed", () => {
  const requestId = "accounting-ok";
  setupRootWithChild(requestId);
  const text = renderCard(requestId, false).join("\n");
  expect(text).toContain("1 spawned");
  expect(text).toContain("explorer 1⟳");
});

test.each([false, true])(
  "render (expanded=%p) propagates ledger query failure instead of dropping usage",
  (expanded) => {
    const requestId = `accounting-query-failure-${expanded}`;
    setupRootWithChild(requestId);
    failingIds.add(requestId);
    expect(() => renderCard(requestId, expanded)).toThrow(queryFailure);
  },
);
