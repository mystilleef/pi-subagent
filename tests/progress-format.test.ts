import { describe, expect, jest, mock, test } from "bun:test";
import * as realOs from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  type PathAnchors,
  renderToolActivityPieces,
} from "../src/progress/activity-display.js";
import { formatElapsed, formatHeaderStats } from "../src/progress/progress.js";
import {
  formatContextPercent,
  formatDescendantTally,
  formatDisplayIdentity,
  formatLiveElapsed,
  formatUsageTree,
  renderToolActivity,
  SENSITIVE_PATTERN,
} from "../src/progress/progress-format.js";
import type {
  AdditiveUsage,
  ToolActivity,
  UsageInstanceNode,
} from "../src/shared/types.js";
import {
  computeSubtreeRollup,
  createEmptyAdditiveUsage,
} from "../src/shared/usage-accounting.js";
import { serializeUsageSnapshot } from "../src/shared/usage-snapshot.js";

/** Plain text of the display-only activity line. */
function renderActivityText(
  activity: ToolActivity | undefined,
  maxChars: number,
  anchors?: PathAnchors,
): string {
  return renderToolActivityPieces(activity, maxChars, anchors)
    .map((piece) => piece.text)
    .join("");
}

describe("formatContextPercent", () => {
  test("returns --% when contextWindowTokens is undefined", () => {
    expect(formatContextPercent({})).toBe("--%");
  });

  test.each([
    {
      name: "returns --% when contextWindowTokens is zero",
      contextWindowTokens: 0,
      expected: "--%",
    },
    {
      name: "returns 0% when contextTokens is undefined with valid window",
      contextWindowTokens: 1000,
      expected: "0%",
    },
  ])("$name", (row) => {
    expect(
      formatContextPercent({ contextWindowTokens: row.contextWindowTokens }),
    ).toBe(row.expected);
  });

  test("returns --% when contextWindowTokens is negative", () => {
    expect(formatContextPercent({ contextWindowTokens: -100 })).toBe("--%");
  });

  test("returns --% when contextWindowTokens is not finite", () => {
    expect(formatContextPercent({ contextWindowTokens: Number.NaN })).toBe(
      "--%",
    );
    expect(
      formatContextPercent({ contextWindowTokens: Number.POSITIVE_INFINITY }),
    ).toBe("--%");
  });

  test.each([
    {
      name: "returns 0% when contextTokens is zero with valid window",
      contextTokens: 0,
      expected: "0%",
    },
    {
      name: "returns correct percentage for valid inputs",
      contextTokens: 500,
      expected: "50%",
    },
    {
      name: "returns 100% when tokens equal window",
      contextTokens: 1000,
      expected: "100%",
    },
    {
      name: "rounds to nearest integer percent",
      contextTokens: 333,
      expected: "33%",
    },
    {
      name: "returns 0% for small fractions that round down",
      contextTokens: 4,
      expected: "0%",
    },
  ])("$name", (row) => {
    expect(
      formatContextPercent({
        contextTokens: row.contextTokens,
        contextWindowTokens: 1000,
      }),
    ).toBe(row.expected);
  });

  test("returns 0% when contextTokens is negative with valid window", () => {
    expect(
      formatContextPercent({ contextTokens: -5, contextWindowTokens: 1000 }),
    ).toBe("0%");
  });

  test("returns 0% when contextTokens is not finite with valid window", () => {
    expect(
      formatContextPercent({
        contextTokens: Number.NaN,
        contextWindowTokens: 1000,
      }),
    ).toBe("0%");
  });

  test("handles large numbers correctly", () => {
    expect(
      formatContextPercent({
        contextTokens: 75000,
        contextWindowTokens: 200000,
      }),
    ).toBe("38%");
  });
});

test("SENSITIVE_PATTERN matches sensitive terms and mixed content", () => {
  expect(SENSITIVE_PATTERN.test("secret")).toBe(true);
  expect(SENSITIVE_PATTERN.test("token")).toBe(true);
  expect(SENSITIVE_PATTERN.test("password")).toBe(true);
  expect(SENSITIVE_PATTERN.test("apiToken")).toBe(true);
  expect(SENSITIVE_PATTERN.test("user_password")).toBe(true);
  expect(SENSITIVE_PATTERN.test("benign preface token=abc benign suffix")).toBe(
    true,
  );
  expect(SENSITIVE_PATTERN.test("safe context only")).toBe(false);
});

test.each([
  {
    name: "formatElapsed renders seconds for short durations",
    elapsedMs: 2500,
    expected: "2.5s",
  },
  {
    name: "formatElapsed renders minutes and seconds for long durations",
    elapsedMs: 90000,
    expected: "1m 30s",
  },
  { name: "formatElapsed renders 0s for zero", elapsedMs: 0, expected: "0.0s" },
])("$name", (row) => {
  expect(formatElapsed(row.elapsedMs)).toBe(row.expected);
});

test.each([
  { name: "floors zero", elapsedMs: 0, expected: "0s" },
  { name: "floors fractional", elapsedMs: 2500, expected: "2s" },
  { name: "floors just-below-minute", elapsedMs: 59_999, expected: "59s" },
  { name: "keeps minute boundary", elapsedMs: 60_000, expected: "1m 0s" },
  { name: "keeps minutes and seconds", elapsedMs: 90_000, expected: "1m 30s" },
  { name: "clamps negative to zero", elapsedMs: -500, expected: "0s" },
  { name: "clamps NaN to zero", elapsedMs: Number.NaN, expected: "0s" },
  {
    name: "clamps positive infinity to zero",
    elapsedMs: Number.POSITIVE_INFINITY,
    expected: "0s",
  },
])("formatLiveElapsed $name", (row) => {
  expect(formatLiveElapsed(row.elapsedMs)).toBe(row.expected);
});

test("format header stats separates live and settled precision", () => {
  const settled = {
    requestId: "req-live",
    agent: "agent-a",
    instanceName: "able-falcon",
    taskPreview: "task a",
    status: "running" as const,
    startTime: 0,
    toolCount: 0,
  };
  jest.setSystemTime(2500);
  try {
    expect(formatHeaderStats(settled)).toBe("0 tools · --% ctx · 2s");
  } finally {
    jest.useRealTimers();
  }
  expect(formatHeaderStats({ ...settled, durationMs: 2500 })).toBe(
    "0 tools · --% ctx · 2.5s",
  );
  jest.setSystemTime(59_999);
  try {
    expect(formatHeaderStats(settled)).toBe("0 tools · --% ctx · 59s");
  } finally {
    jest.useRealTimers();
  }
  jest.setSystemTime(90_000);
  try {
    expect(formatHeaderStats(settled)).toBe("0 tools · --% ctx · 1m 30s");
  } finally {
    jest.useRealTimers();
  }
});

test("format header stats renders tool count context percent and elapsed", () => {
  const stats = formatHeaderStats({
    requestId: "req-1",
    agent: "agent-a",
    instanceName: "able-falcon",
    taskPreview: "task a",
    status: "running",
    startTime: 0,
    durationMs: 2500,
    toolCount: 3,
    contextTokens: 18_000,
    contextWindowTokens: 240_000,
    inputTokens: 7100,
    outputTokens: 890,
  });
  expect(stats).toBe("3 tools · 8% ctx · 2.5s");
  expect(stats).not.toContain("7.1k in");
  expect(stats).not.toContain("890 out");
});

test("format header stats pluralizes zero singular and plural tool counts", () => {
  const base = {
    requestId: "req-1",
    agent: "agent-a",
    instanceName: "able-falcon",
    taskPreview: "task a",
    status: "running" as const,
    startTime: 0,
    durationMs: 2500,
  };
  expect(formatHeaderStats({ ...base, toolCount: 0 })).toBe(
    "0 tools · --% ctx · 2.5s",
  );
  expect(formatHeaderStats({ ...base, toolCount: 1 })).toBe(
    "1 tool · --% ctx · 2.5s",
  );
  expect(formatHeaderStats({ ...base, toolCount: 2 })).toBe(
    "2 tools · --% ctx · 2.5s",
  );
});

test("format header stats handles zero usage and context fallbacks", () => {
  jest.setSystemTime(4000);
  try {
    const base = {
      requestId: "req-1",
      agent: "agent-a",
      instanceName: "able-falcon",
      taskPreview: "task a",
      status: "running" as const,
      startTime: 1000,
      toolCount: 0,
    };
    expect(formatHeaderStats(base)).toBe("0 tools · --% ctx · 3s");
    expect(
      formatHeaderStats({
        ...base,
        contextTokens: -1,
        contextWindowTokens: 100,
      }),
    ).toBe("0 tools · 0% ctx · 3s");
    expect(
      formatHeaderStats({
        ...base,
        contextTokens: Number.NaN,
        contextWindowTokens: 100,
      }),
    ).toBe("0 tools · 0% ctx · 3s");
    expect(
      formatHeaderStats({ ...base, contextTokens: 50, contextWindowTokens: 0 }),
    ).toBe("0 tools · --% ctx · 3s");
    expect(
      formatHeaderStats({
        ...base,
        contextTokens: 50,
        contextWindowTokens: Number.POSITIVE_INFINITY,
      }),
    ).toBe("0 tools · --% ctx · 3s");
  } finally {
    jest.useRealTimers();
  }
});

test("renderToolActivity returns undefined for undefined activity", () => {
  expect(renderToolActivity(undefined)).toBeUndefined();
});

test("renderToolActivity returns toolName when no inputSummary", () => {
  expect(renderToolActivity({ toolName: "bash" })).toBe("bash");
});

test("renderToolActivity renders depth-1 with inputSummary", () => {
  expect(renderToolActivity({ toolName: "bash", inputSummary: "ls -la" })).toBe(
    "ls -la",
  );
});

test("renderToolActivity annotates instanceName at depth-1", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
    }),
  ).toBe("subagent: build swift-harbor");
});

test("renderToolActivity renders depth-2 joining parent and child", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    }),
  ).toBe("subagent: build swift-harbor - bash: make build");
});

test("renderToolActivity renders depth-3 joining all levels", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "subagent: plan",
      instanceName: "outer-inst",
      child: {
        toolName: "subagent",
        inputSummary: "subagent: build",
        instanceName: "inner-inst",
        child: {
          toolName: "bash",
          inputSummary: "bash: make test",
        },
      },
    }),
  ).toBe(
    "subagent: plan outer-inst - subagent: build inner-inst - bash: make test",
  );
});

test("renderToolActivity renders depth-4 traversing full chain", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "level-1",
      child: {
        toolName: "subagent",
        inputSummary: "level-2",
        child: {
          toolName: "subagent",
          inputSummary: "level-3",
          child: {
            toolName: "bash",
            inputSummary: "level-4",
          },
        },
      },
    }),
  ).toBe("level-1 - level-2 - level-3 - level-4");
});

test("renderToolActivity skips nodes without inputSummary", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "parent-summary",
      child: {
        toolName: "wrapper",
        child: {
          toolName: "bash",
          inputSummary: "grandchild-summary",
        },
      },
    }),
  ).toBe("parent-summary - grandchild-summary");
});

test("renderToolActivityPieces renders thinking without an active tool", () => {
  expect(renderToolActivityPieces(undefined, 80)).toEqual([
    { role: "inferred", text: "thinking" },
  ]);
});

test("renderActivityText returns toolName when no inputSummary", () => {
  expect(renderActivityText({ toolName: "bash" }, 80)).toBe("bash");
});

test.each([
  {
    name: "renderActivityText renders depth-1 with budget",
    inputSummary: "ls -la",
    budget: 80,
    expected: "bash ls -la",
  },
  {
    name: "renderActivityText returns empty string for zero budget",
    inputSummary: "bash: ls",
    budget: 0,
    expected: "",
  },
])("$name", (row) => {
  expect(
    renderActivityText(
      { toolName: "bash", inputSummary: row.inputSummary },
      row.budget,
    ),
  ).toBe(row.expected);
});

test("renderActivityText truncates innermost once with shared budget", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary:
      "first-segment-that-is-sixty-characters-long-padding-here-now",
    child: {
      toolName: "bash",
      inputSummary:
        "second-segment-that-is-also-sixty-characters-long-padding-here",
    },
  };
  const result = renderActivityText(activity, 40);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(40);
  expect(result).toContain("bash");
  expect(result).toContain("second-segment");
  expect(result).not.toContain("first-segment");
  expect(result).toMatch(/…$/);
});

test("renderActivityText preserves innermost when within budget", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "short-one",
    child: {
      toolName: "bash",
      inputSummary: "short-two",
    },
  };
  expect(renderActivityText(activity, 80)).toBe("bash short-two");
});

test("renderActivityText replaces only sensitive target with hidden", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading config",
    child: {
      toolName: "bash",
      inputSummary: "secret-token.yaml",
    },
  };
  expect(renderActivityText(activity, 80)).toBe("bash (hidden)");
});

test("renderActivityText shows innermost tool when parent unnamed", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "parent-task",
    instanceName: "alpha",
    child: {
      toolName: "bash",
      inputSummary: "child-task",
    },
  };
  expect(renderActivityText(activity, 80)).toBe("bash child-task");
});

test("renderActivityText applies tight budget correctly", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "this-is-a-very-long-first-segment",
    child: {
      toolName: "bash",
      inputSummary: "this-is-a-very-long-second-segment",
    },
  };
  const result = renderActivityText(activity, 30);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(30);
  expect(result).toMatch(/…$/);
});

test("renderActivityText respects narrow width budget", () => {
  const activity: ToolActivity = {
    toolName: "bash",
    inputSummary:
      "bash: this-is-a-very-long-command-that-exceeds-narrow-budget",
  };
  const result = renderActivityText(activity, 20);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(20);
  expect(result).toMatch(/…$/);
});

test("renderActivityText returns empty string for negative budget", () => {
  expect(
    renderActivityText({ toolName: "bash", inputSummary: "bash: ls" }, -5),
  ).toBe("");
});

test("renderActivityText returns empty string for zero budget with sensitive text", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading secret-token.yaml",
  };
  expect(renderActivityText(activity, 0)).toBe("");
});

test("renderActivityText protects sensitive target through budget", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading config",
    child: { toolName: "bash", inputSummary: "cat secret-token.yaml" },
  };
  expect(renderActivityText(activity, 80)).toBe("bash (hidden)");
  expect(renderActivityText(activity, 0)).toBe("");
});

test("renderActivityText handles very narrow budget gracefully", () => {
  const activity: ToolActivity = {
    toolName: "bash",
    inputSummary: "bash: command",
  };
  const result = renderActivityText(activity, 5);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(5);
});

test("renderActivityText truncates nested activity at narrow width", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "subagent: build-task-with-long-description",
    child: {
      toolName: "bash",
      inputSummary: "bash: make-build-with-verbose-output",
    },
  };
  const result = renderActivityText(activity, 40);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(40);
  expect(result).toContain("build-task-with-long-description");
  expect(result).toContain("bash");
  expect(result).not.toContain("subagent:");
  expect(result).not.toContain("make-build-with-verbose-output");
});

test("sensitive target protection preserves tool and shows hidden", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading config",
    child: {
      toolName: "bash",
      inputSummary: "bash: cat secret-token.yaml",
    },
  };
  const result = renderActivityText(activity, 80);
  expect(result).toBe("bash (hidden)");
});

test("renderToolActivity retains existing 120 character truncation for stored previews", () => {
  const longSummary = "x".repeat(200);
  const activity: ToolActivity = {
    toolName: "bash",
    inputSummary: longSummary,
  };
  const result = renderToolActivity(activity);
  expect(result).toBeDefined();
  if (result) {
    expect(Array.from(result).length).toBeLessThanOrEqual(120);
    expect(result).toEndWith("…");
  }
});

test("renderToolActivity depth-2 retains truncation for stored previews", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "parent-summary",
    child: {
      toolName: "bash",
      inputSummary: "x".repeat(200),
    },
  };
  const result = renderToolActivity(activity);
  expect(result).toBeDefined();
  if (result) {
    expect(result).toContain("parent-summary");
    expect(result).toContain(" - ");
  }
});

describe("ordinal-aware nested activity segments", () => {
  test("hides ordinal 1 before the instance name", () => {
    expect(
      renderToolActivity({
        toolName: "subagent",
        inputSummary: "subagent: build",
        instanceName: "swift-harbor",
        ordinal: 1,
      }),
    ).toBe("subagent: build swift-harbor");
  });

  test("inserts #ordinal before the instance name for ordinal >=2", () => {
    expect(
      renderToolActivity({
        toolName: "subagent",
        inputSummary: "subagent: build",
        instanceName: "brave-otter",
        ordinal: 3,
      }),
    ).toBe("subagent: build #3 brave-otter");
  });

  test("preserves child nesting with ordinal threshold at each level", () => {
    expect(
      renderToolActivity({
        toolName: "subagent",
        inputSummary: "subagent: plan",
        instanceName: "outer-inst",
        ordinal: 2,
        child: {
          toolName: "subagent",
          inputSummary: "subagent: build",
          instanceName: "inner-inst",
          ordinal: 1,
          child: { toolName: "bash", inputSummary: "bash: make test" },
        },
      }),
    ).toBe(
      "subagent: plan #2 outer-inst - subagent: build inner-inst - bash: make test",
    );
  });

  test("omits ordinal when instanceName missing", () => {
    expect(
      renderToolActivity({
        toolName: "subagent",
        inputSummary: "subagent: build",
        ordinal: 2,
      }),
    ).toBe("subagent: build");
  });

  test("display renders delegate without tool as thinking with identity", () => {
    const activity: ToolActivity = {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "brave-otter",
      ordinal: 2,
    };
    expect(renderActivityText(activity, 80)).toBe(
      "build #2 brave-otter › thinking",
    );
    expect(
      renderActivityText(
        {
          toolName: "subagent",
          inputSummary: "subagent: build",
          instanceName: "brave-otter",
          ordinal: 1,
        },
        80,
      ),
    ).toBe("build brave-otter › thinking");
  });
});

describe("formatDescendantTally aggregation", () => {
  function usage(overrides: Partial<AdditiveUsage> = {}): AdditiveUsage {
    return { ...createEmptyAdditiveUsage(), ...overrides };
  }
  function node(
    overrides: Partial<UsageInstanceNode> &
      Pick<UsageInstanceNode, "agent" | "instanceName">,
  ): UsageInstanceNode {
    return {
      id: `${overrides.agent}-${overrides.instanceName}-${overrides.ordinal ?? 1}-${overrides.startedAt ?? 1000}`,
      ordinal: 1,
      startedAt: 1000,
      status: "success",
      usage: usage(),
      children: [],
      ...overrides,
    };
  }
  test("returns undefined for leaf without descendants", () => {
    const root = node({ agent: "root", instanceName: "solo", id: "root-1" });
    expect(formatDescendantTally(root, 80)).toBeUndefined();
  });
  test("aggregates all depths excluding self", () => {
    const grandchild = node({
      agent: "build",
      instanceName: "grand",
      id: "grand-1",
      startedAt: 2000,
    });
    const child = node({
      agent: "wrap",
      instanceName: "mid",
      id: "mid-1",
      startedAt: 1000,
      children: [grandchild],
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [child],
    });
    const tally = formatDescendantTally(root, 200);
    expect(tally).toBeDefined();
    expect(tally).toContain("2 spawned");
    expect(tally).not.toContain("root");
    expect(tally).toContain("build \u27131");
    expect(tally).toContain("wrap \u27131");
    expect(tally).toContain("run $0.0000");
  });
  test("includes omitted contributions exactly once including cost", () => {
    const child = node({
      agent: "build",
      instanceName: "kept",
      id: "kept-1",
      startedAt: 1000,
    });
    const omittedChild = node({
      agent: "spec",
      instanceName: "trimmed",
      id: "trimmed-1",
      startedAt: 500,
    });
    const omittedTotals = computeSubtreeRollup(omittedChild);
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [child],
      omitted: { count: omittedTotals.instances, totals: omittedTotals },
    });
    const tally = formatDescendantTally(root, 200);
    expect(tally).toContain("2 spawned");
    expect(tally).toContain("build \u27131");
    expect(tally).toContain("spec \u27131");
    expect(tally).toContain("run $0.0000");
  });
  test("formats single-status groups without parentheses", () => {
    const child = node({
      agent: "fix",
      instanceName: "one",
      id: "fix-1",
      startedAt: 1000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [child],
    });
    expect(formatDescendantTally(root, 80)).toBe(
      "1 spawned \u00b7 fix \u27131 \u00b7 run $0.0000",
    );
  });
  test("formats multi-status groups with nonzero counts only", () => {
    const a = node({
      agent: "build",
      instanceName: "a",
      id: "a-1",
      status: "success",
      startedAt: 1000,
    });
    const b = node({
      agent: "build",
      instanceName: "b",
      id: "b-1",
      status: "running",
      startedAt: 2000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [a, b],
    });
    const tally = formatDescendantTally(root, 200);
    expect(tally).toBe(
      "2 spawned \u00b7 build 2 (\u27131 \u27f31) \u00b7 run $0.0000",
    );
    expect(tally).not.toContain("0\u2717");
    expect(tally).not.toContain("0\u2298");
  });
});

describe("formatDescendantTally ordering", () => {
  function usage(): AdditiveUsage {
    return createEmptyAdditiveUsage();
  }
  function node(
    overrides: Partial<UsageInstanceNode> &
      Pick<UsageInstanceNode, "agent" | "instanceName">,
  ): UsageInstanceNode {
    return {
      id: `${overrides.agent}-${overrides.instanceName}-${overrides.startedAt ?? 1000}`,
      ordinal: 1,
      startedAt: 1000,
      status: "success",
      usage: usage(),
      children: [],
      ...overrides,
    };
  }
  test("orders running then error then success tiers", () => {
    const running = node({
      agent: "build",
      instanceName: "r",
      id: "r-1",
      status: "running",
      startedAt: 1000,
    });
    const failing = node({
      agent: "check",
      instanceName: "e",
      id: "e-1",
      status: "error",
      startedAt: 5000,
    });
    const ok = node({
      agent: "fix",
      instanceName: "s",
      id: "s-1",
      status: "success",
      startedAt: 9000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [ok, failing, running],
    });
    const tally = formatDescendantTally(root, 300);
    expect(tally).toBeDefined();
    const buildIdx = tally?.indexOf("build") ?? -1;
    const checkIdx = tally?.indexOf("check") ?? -1;
    const fixIdx = tally?.indexOf("fix") ?? -1;
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBeGreaterThan(buildIdx);
    expect(fixIdx).toBeGreaterThan(checkIdx);
  });
  test("orders cancelled with error tier before success", () => {
    const cancelled = node({
      agent: "check",
      instanceName: "c",
      id: "c-1",
      status: "cancelled",
      startedAt: 1000,
    });
    const ok = node({
      agent: "fix",
      instanceName: "s",
      id: "s-1",
      status: "success",
      startedAt: 9000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [ok, cancelled],
    });
    const tally = formatDescendantTally(root, 200);
    expect(tally?.indexOf("check") ?? 99).toBeLessThan(
      tally?.indexOf("fix") ?? -1,
    );
  });
  test("orders same tier by latest startedAt descending", () => {
    const older = node({
      agent: "aaa",
      instanceName: "old",
      id: "old-1",
      status: "running",
      startedAt: 1000,
    });
    const newer = node({
      agent: "zzz",
      instanceName: "new",
      id: "new-1",
      status: "running",
      startedAt: 5000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [older, newer],
    });
    const tally = formatDescendantTally(root, 200);
    expect(tally?.indexOf("zzz") ?? 99).toBeLessThan(
      tally?.indexOf("aaa") ?? -1,
    );
  });
  test("places undated omitted-only groups after dated groups", () => {
    const dated = node({
      agent: "aaa",
      instanceName: "kept",
      id: "kept-1",
      status: "success",
      startedAt: 1000,
    });
    const omittedOnly = node({
      agent: "zzz",
      instanceName: "trimmed",
      id: "trimmed-1",
      status: "success",
      startedAt: 2000,
    });
    const omittedTotals = computeSubtreeRollup(omittedOnly);
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [dated],
      omitted: { count: omittedTotals.instances, totals: omittedTotals },
    });
    const tally = formatDescendantTally(root, 200);
    expect(tally).toContain("aaa");
    expect(tally).toContain("zzz");
    expect(tally?.indexOf("aaa") ?? 99).toBeLessThan(
      tally?.indexOf("zzz") ?? -1,
    );
  });
  test("breaks equal timestamps by agent name", () => {
    const b = node({
      agent: "bbb",
      instanceName: "one",
      id: "b-1",
      status: "success",
      startedAt: 1000,
    });
    const a = node({
      agent: "aaa",
      instanceName: "two",
      id: "a-1",
      status: "success",
      startedAt: 1000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [b, a],
    });
    const tally = formatDescendantTally(root, 200);
    expect(tally?.indexOf("aaa") ?? 99).toBeLessThan(
      tally?.indexOf("bbb") ?? -1,
    );
  });
  test("uses deepest retained timestamp for recency", () => {
    const recentGrandchild = node({
      agent: "build",
      instanceName: "recent",
      id: "recent-1",
      status: "running",
      startedAt: 5000,
    });
    const wrapper = node({
      agent: "wrap",
      instanceName: "mid",
      id: "mid-1",
      status: "success",
      startedAt: 1000,
      children: [recentGrandchild],
    });
    const directOld = node({
      agent: "build",
      instanceName: "old",
      id: "old-1",
      status: "running",
      startedAt: 2000,
    });
    const competing = node({
      agent: "fix",
      instanceName: "mid",
      id: "fix-1",
      status: "running",
      startedAt: 4000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [wrapper, directOld, competing],
    });
    const tally = formatDescendantTally(root, 300);
    expect(tally?.indexOf("build") ?? 99).toBeLessThan(
      tally?.indexOf("fix") ?? -1,
    );
  });
});

describe("formatDescendantTally width", () => {
  function usage(): AdditiveUsage {
    return createEmptyAdditiveUsage();
  }
  function node(
    overrides: Partial<UsageInstanceNode> &
      Pick<UsageInstanceNode, "agent" | "instanceName">,
  ): UsageInstanceNode {
    return {
      id: `${overrides.agent}-${overrides.instanceName}-${overrides.startedAt ?? 1000}`,
      ordinal: 1,
      startedAt: 1000,
      status: "success",
      usage: usage(),
      children: [],
      ...overrides,
    };
  }
  function threeAgentRoot(): UsageInstanceNode {
    const a = node({
      agent: "aaa",
      instanceName: "one",
      id: "a-1",
      startedAt: 3000,
    });
    const b = node({
      agent: "bbb",
      instanceName: "two",
      id: "b-1",
      startedAt: 2000,
    });
    const c = node({
      agent: "ccc",
      instanceName: "three",
      id: "c-1",
      startedAt: 1000,
    });
    return node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [a, b, c],
    });
  }
  test("returns full tally when width fits", () => {
    const root = threeAgentRoot();
    const full = formatDescendantTally(root, 1000);
    expect(full).toContain("3 spawned");
    expect(full).toContain("aaa");
    expect(full).toContain("bbb");
    expect(full).toContain("ccc");
    expect(full).not.toContain("more");
  });
  test("drops whole groups from end with hidden count", () => {
    const root = threeAgentRoot();
    const full = formatDescendantTally(root, 1000) as string;
    const truncated = formatDescendantTally(root, Bun.stringWidth(full) - 10);
    expect(truncated).toBeDefined();
    expect(truncated).toContain("more");
    expect(Bun.stringWidth(truncated as string)).toBeLessThanOrEqual(
      Bun.stringWidth(full) - 10,
    );
    expect(truncated).not.toContain("ccc");
  });
  test("counts hidden agent groups in omission marker", () => {
    const root = threeAgentRoot();
    const full = formatDescendantTally(root, 1000) as string;
    const justPrefix = `${computeSubtreeRollup(root).instances - 0 - 0} spawned`;
    void justPrefix;
    void full;
    const narrow = formatDescendantTally(root, 38);
    expect(narrow).toBeDefined();
    expect(narrow).toMatch(/\+\d+ more/);
    expect(narrow).toContain("run $0.0000");
  });
  test("suppresses tally when prefix plus marker cannot fit", () => {
    const root = threeAgentRoot();
    expect(formatDescendantTally(root, 5)).toBeUndefined();
    expect(formatDescendantTally(root, 0)).toBeUndefined();
  });
  test("never overflows content width", () => {
    const root = threeAgentRoot();
    for (const width of [10, 15, 20, 30, 50, 100]) {
      const result = formatDescendantTally(root, width);
      if (result !== undefined) {
        expect(Bun.stringWidth(result)).toBeLessThanOrEqual(width);
      }
    }
  });
  test("suppresses tally when wide agent name exceeds content width", () => {
    const wide = node({ agent: "\u732b\u732b", instanceName: "c" });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [wide],
    });
    expect(formatDescendantTally(root, 18)).toBeUndefined();
  });
  test("keeps tally when wide agent name fits column width", () => {
    const wide = node({ agent: "\u732b\u732b", instanceName: "c" });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [wide],
    });
    expect(formatDescendantTally(root, 38)).toBe(
      "1 spawned \u00b7 \u732b\u732b \u27131 \u00b7 run $0.0000",
    );
  });
});

describe("formatUsageTree views", () => {
  function usage(): AdditiveUsage {
    return createEmptyAdditiveUsage();
  }
  function node(
    overrides: Partial<UsageInstanceNode> &
      Pick<UsageInstanceNode, "agent" | "instanceName">,
  ): UsageInstanceNode {
    return {
      id: `${overrides.agent}-${overrides.instanceName}-${overrides.ordinal ?? 1}`,
      ordinal: 1,
      startedAt: 1000,
      status: "success",
      usage: usage(),
      children: [],
      ...overrides,
    };
  }
  test("shows root in root-inclusive view hiding it otherwise", () => {
    const child = node({
      agent: "build",
      instanceName: "leaf",
      id: "leaf-1",
      ordinal: 1,
      startedAt: 1000,
      durationMs: 250,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      ordinal: 2,
      startedAt: 500,
      children: [child],
    });
    const inclusive = formatUsageTree(root, { includeRoot: true, now: 5000 });
    const exclusive = formatUsageTree(root, { includeRoot: false, now: 5000 });
    expect(inclusive.some((line) => line.includes("top"))).toBe(true);
    expect(exclusive.some((line) => line.includes("top"))).toBe(false);
    expect(exclusive.some((line) => line.includes("leaf"))).toBe(true);
  });
  test("hides ordinal 1 in tree nodes", () => {
    const child = node({
      agent: "build",
      instanceName: "leaf",
      id: "leaf-1",
      ordinal: 1,
      startedAt: 1000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [child],
    });
    const lines = formatUsageTree(root, { includeRoot: true, now: 2000 });
    expect(lines.some((line) => line.includes("build leaf"))).toBe(true);
    expect(lines.some((line) => line.includes("#1"))).toBe(false);
  });
  test("orders siblings by startedAt ascending", () => {
    const later = node({
      agent: "build",
      instanceName: "later",
      id: "later-1",
      startedAt: 3000,
    });
    const earlier = node({
      agent: "build",
      instanceName: "earlier",
      id: "earlier-1",
      startedAt: 1000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [later, earlier],
    });
    const lines = formatUsageTree(root, { now: 5000 });
    const earlierIdx = lines.findIndex((line) => line.includes("earlier"));
    const laterIdx = lines.findIndex((line) => line.includes("later"));
    expect(earlierIdx).toBeGreaterThanOrEqual(0);
    expect(laterIdx).toBeGreaterThan(earlierIdx);
  });
  test("indents once per parent and marks omitted at child indent", () => {
    const kept = node({
      agent: "build",
      instanceName: "kept",
      id: "kept-1",
      startedAt: 1000,
    });
    const trimmed = node({
      agent: "spec",
      instanceName: "trimmed",
      id: "trimmed-1",
      startedAt: 500,
    });
    const omittedTotals = computeSubtreeRollup(trimmed);
    const child = node({
      agent: "wrap",
      instanceName: "mid",
      id: "mid-1",
      startedAt: 800,
      children: [kept],
      omitted: { count: omittedTotals.instances, totals: omittedTotals },
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [child],
    });
    const lines = formatUsageTree(root, { includeRoot: true, now: 5000 });
    const childLine = lines.find((line) => line.includes("mid")) as string;
    const keptLine = lines.find((line) => line.includes("kept")) as string;
    const omittedLine = lines.find((line) =>
      line.includes("earlier"),
    ) as string;
    expect(childLine.startsWith("  ")).toBe(true);
    expect(keptLine.startsWith("    ")).toBe(true);
    expect(omittedLine).toBe("    +1 earlier");
  });
  test("shows running elapsed and terminal durations", () => {
    const running = node({
      agent: "build",
      instanceName: "live",
      id: "live-1",
      status: "running",
      startedAt: 1000,
    });
    const done = node({
      agent: "fix",
      instanceName: "done",
      id: "done-1",
      status: "success",
      startedAt: 500,
      durationMs: 2500,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      status: "running",
      children: [running, done],
    });
    const lines = formatUsageTree(root, { now: 3500 });
    expect(
      lines.some((line) => line.includes("live") && line.includes("· 2s")),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes("live") && line.includes("2.5s")),
    ).toBe(false);
    expect(
      lines.some((line) => line.includes("done") && line.includes("2.5s")),
    ).toBe(true);
  });
  test("omits duration when terminal duration unavailable", () => {
    const noDuration = node({
      agent: "build",
      instanceName: "nodur",
      id: "nodur-1",
      status: "success",
      startedAt: 1000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [noDuration],
    });
    const lines = formatUsageTree(root, { now: 2000 });
    const line = lines.find((l) => l.includes("nodur")) as string;
    expect(line).toBe("\u2713 build nodur");
  });
  test("falls back to zero elapsed for unusable clock inputs", () => {
    const running = node({
      agent: "build",
      instanceName: "live",
      id: "live-1",
      status: "running",
      startedAt: 1000,
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      status: "running",
      children: [running],
    });
    const nanNow = formatUsageTree(root, { now: Number.NaN });
    expect(
      nanNow.some((line) => line.includes("live") && line.includes("· 0s")),
    ).toBe(true);
    const badStart = node({
      agent: "fix",
      instanceName: "bad",
      id: "bad-1",
      status: "running",
      startedAt: Number.NaN,
    });
    const badRoot = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      status: "running",
      children: [badStart],
    });
    const badLines = formatUsageTree(badRoot, { now: 5000 });
    expect(
      badLines.some((line) => line.includes("bad") && line.includes("· 0s")),
    ).toBe(true);
  });
  test("orders same-time siblings by agent, instance name, then id", () => {
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [
        node({
          agent: "beta",
          instanceName: "same",
          id: "z-1",
          startedAt: 1000,
        }),
        node({
          agent: "alpha",
          instanceName: "one",
          id: "a-1",
          startedAt: 1000,
        }),
        node({
          agent: "beta",
          instanceName: "other",
          id: "b-2",
          startedAt: 1000,
          status: "error",
        }),
        node({
          agent: "beta",
          instanceName: "other",
          id: "b-1",
          startedAt: 1000,
          status: "success",
        }),
      ],
    });
    const joined = formatUsageTree(root, { now: 5000 }).join("\n");
    expect(joined.indexOf("alpha")).toBeLessThan(joined.indexOf("beta"));
    expect(joined.indexOf("\u2713 beta other")).toBeLessThan(
      joined.indexOf("\u2717 beta other"),
    );
    expect(joined.indexOf("other")).toBeLessThan(joined.indexOf("same"));
  });
});

describe("formatUsageTree bounding", () => {
  function usage(): AdditiveUsage {
    return createEmptyAdditiveUsage();
  }
  function chainRoot(total: number): UsageInstanceNode {
    let current: UsageInstanceNode = {
      id: `chain-${total}`,
      agent: "build",
      instanceName: `n-${total}`,
      ordinal: 1,
      startedAt: total * 10,
      status: "success",
      durationMs: 10,
      usage: usage(),
      children: [],
    };
    for (let i = total - 1; i >= 1; i -= 1) {
      current = {
        id: `chain-${i}`,
        agent: "build",
        instanceName: `n-${i}`,
        ordinal: 1,
        startedAt: i * 10,
        status: "success",
        durationMs: 10,
        usage: usage(),
        children: [current],
      };
    }
    return {
      id: "root-chain",
      agent: "root",
      instanceName: "top",
      ordinal: 1,
      startedAt: 0,
      status: "success",
      durationMs: 10,
      usage: usage(),
      children: [current],
    };
  }
  test("bounds explicit nodes to 50 including root", () => {
    const root = chainRoot(70);
    const inclusive = formatUsageTree(root, { includeRoot: true, now: 10000 });
    const explicit = inclusive.filter((line) => line.includes("#"));
    expect(explicit.length).toBeLessThanOrEqual(50);
    expect(inclusive.some((line) => line.includes("earlier"))).toBe(true);
  });
  test("bounds descendants-only below 50 counting hidden root", () => {
    const root = chainRoot(70);
    const exclusive = formatUsageTree(root, { includeRoot: false, now: 10000 });
    const explicit = exclusive.filter((line) => line.includes("#"));
    expect(explicit.length).toBeLessThanOrEqual(49);
    expect(exclusive.some((line) => line.includes("earlier"))).toBe(true);
  });
  test("preserves exact totals through omitted rollups", () => {
    const root = chainRoot(70);
    const before = computeSubtreeRollup(root);
    const bounded = serializeUsageSnapshot(root);
    const after = computeSubtreeRollup(bounded);
    expect(after.instances).toBe(before.instances);
    expect(after.usage.turns).toBe(before.usage.turns);
    expect(
      formatUsageTree(root, { includeRoot: true, now: 10000 }).length,
    ).toBeGreaterThan(0);
  });
  test("keeps full tally total despite tree bounding", () => {
    const root = chainRoot(70);
    const tally = formatDescendantTally(root, 1000);
    expect(tally).toContain("70 spawned");
    const tree = formatUsageTree(root, { includeRoot: true, now: 10000 });
    const explicit = tree.filter((line) => line.includes("#"));
    expect(explicit.length).toBeLessThanOrEqual(50);
  });
});

describe("accounting-only text", () => {
  function usage(): AdditiveUsage {
    return createEmptyAdditiveUsage();
  }
  test("contains only names ordinals counts statuses durations", () => {
    const child: UsageInstanceNode = {
      id: "child-1",
      agent: "build",
      instanceName: "swift-fox",
      ordinal: 2,
      startedAt: 1000,
      status: "success",
      durationMs: 1500,
      usage: usage(),
      children: [],
    };
    const root: UsageInstanceNode = {
      id: "root-1",
      agent: "root",
      instanceName: "top",
      ordinal: 1,
      startedAt: 500,
      status: "success",
      usage: usage(),
      children: [child],
    };
    const tally = formatDescendantTally(root, 200) as string;
    const lines = formatUsageTree(root, { includeRoot: true, now: 5000 });
    const combined = `${tally} ${lines.join(" ")}`;
    expect(combined).toContain("build");
    expect(combined).toContain("swift-fox");
    expect(combined).not.toContain("secret task");
    expect(combined).not.toContain("prompt");
    expect(combined).not.toContain("transcript");
    expect(combined).not.toContain("stderr");
  });
});

describe("formatDescendantTally run cost", () => {
  function usage(overrides: Partial<AdditiveUsage> = {}): AdditiveUsage {
    return { ...createEmptyAdditiveUsage(), ...overrides };
  }
  function node(
    overrides: Partial<UsageInstanceNode> &
      Pick<UsageInstanceNode, "agent" | "instanceName">,
  ): UsageInstanceNode {
    return {
      id: `${overrides.agent}-${overrides.instanceName}-${overrides.ordinal ?? 1}-${overrides.startedAt ?? 1000}`,
      ordinal: 1,
      startedAt: 1000,
      status: "success",
      usage: usage(),
      children: [],
      ...overrides,
    };
  }
  test("appends whole-subtree run cost including self exactly once", () => {
    const child = node({
      agent: "worker",
      instanceName: "one",
      id: "child-1",
      usage: usage({ cost: 0.02 }),
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      usage: usage({ cost: 0.01 }),
      children: [child],
    });
    expect(formatDescendantTally(root, 200)).toContain("run $0.0300");
  });
  test("includes omitted totals in run cost exactly once with live running", () => {
    const child = node({
      agent: "worker",
      instanceName: "kept",
      id: "kept-1",
      status: "running",
      usage: usage({ cost: 0.02 }),
    });
    const omittedChild = node({
      agent: "helper",
      instanceName: "trimmed",
      id: "trimmed-1",
      usage: usage({ cost: 0.005 }),
    });
    const omittedTotals = computeSubtreeRollup(omittedChild);
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      usage: usage({ cost: 0.01 }),
      children: [child],
      omitted: { count: omittedTotals.instances, totals: omittedTotals },
    });
    const tally = formatDescendantTally(root, 200) as string;
    expect(tally).toContain("2 spawned");
    expect(tally).toContain("run $0.0350");
  });
  test("omits run suffix for stats tallies while retaining groups", () => {
    const child = node({
      agent: "worker",
      instanceName: "one",
      id: "child-1",
      usage: usage({ cost: 0.02 }),
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      usage: usage({ cost: 0.01 }),
      children: [child],
    });
    const tally = formatDescendantTally(root, 200, {
      includeRunCost: false,
    }) as string;
    expect(tally).toContain("1 spawned");
    expect(tally).toContain("worker \u27131");
    expect(tally).not.toContain("run $");
  });
  test.each([
    { mode: "run-cost", options: undefined, hasRun: true },
    { mode: "stats", options: { includeRunCost: false }, hasRun: false },
  ])(
    "collapses trailing groups before the suffix slot in $mode tallies",
    ({ options, hasRun }) => {
      const mk = (agent: string, at: number) =>
        node({
          agent,
          instanceName: `inst-${agent}`,
          id: `${agent}-1`,
          startedAt: at,
        });
      const root = node({
        agent: "root",
        instanceName: "top",
        id: "root-1",
        children: [mk("aaa", 3000), mk("bbb", 2000), mk("ccc", 1000)],
      });
      const full = formatDescendantTally(root, 1000, options) as string;
      const width = Bun.stringWidth(full) - 10;
      const collapsed = formatDescendantTally(root, width, options) as string;
      expect(collapsed).toMatch(/\+\d+ more/);
      expect(collapsed).not.toContain("aaa");
      expect(full.includes("run $0.0000")).toBe(hasRun);
      expect(collapsed.includes("run $0.0000")).toBe(hasRun);
      expect(Bun.stringWidth(collapsed)).toBeLessThanOrEqual(width);
    },
  );
  test("hides entire tally when prefix marker and run cannot fit", () => {
    const child = node({
      agent: "worker",
      instanceName: "one",
      id: "child-1",
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [child],
    });
    expect(formatDescendantTally(root, 10)).toBeUndefined();
    expect(formatDescendantTally(root, 20)).toBeUndefined();
  });
  test("stats tallies fit widths the run suffix would overflow", () => {
    const child = node({
      agent: "worker",
      instanceName: "one",
      id: "child-1",
    });
    const root = node({
      agent: "root",
      instanceName: "top",
      id: "root-1",
      children: [child],
    });
    const full = formatDescendantTally(root, 1000, {
      includeRunCost: false,
    }) as string;
    expect(full).not.toContain("run $");
    const width = Bun.stringWidth(full);
    expect(formatDescendantTally(root, width, { includeRunCost: false })).toBe(
      full,
    );
    expect(formatDescendantTally(root, width)).toBeUndefined();
    const narrowed = formatDescendantTally(root, width - 1, {
      includeRunCost: false,
    }) as string;
    expect(narrowed).toBe("1 spawned \u00b7 +1 more");
    expect(narrowed).not.toContain("worker");
  });
});

describe("formatDisplayIdentity", () => {
  test.each([
    {
      name: "inserts hash ordinal for valid ordinals",
      base: "worker",
      instanceName: "able-fox",
      ordinal: 2,
      expected: "worker #2 able-fox",
    },
    {
      name: "keeps hash ordinal for later instances",
      base: "worker",
      instanceName: "able-fox",
      ordinal: 7,
      expected: "worker #7 able-fox",
    },
    {
      name: "omits hash for first-instance ordinal",
      base: "worker",
      instanceName: "able-fox",
      ordinal: 1,
      expected: "worker able-fox",
    },
    {
      name: "omits hash when ordinal is undefined",
      base: "worker",
      instanceName: "able-fox",
      ordinal: undefined,
      expected: "worker able-fox",
    },
    {
      name: "omits hash for zero ordinal",
      base: "worker",
      instanceName: "able-fox",
      ordinal: 0,
      expected: "worker able-fox",
    },
    {
      name: "omits hash for negative ordinal",
      base: "worker",
      instanceName: "able-fox",
      ordinal: -3,
      expected: "worker able-fox",
    },
    {
      name: "omits hash for fractional ordinal",
      base: "worker",
      instanceName: "able-fox",
      ordinal: 2.5,
      expected: "worker able-fox",
    },
    {
      name: "omits hash for NaN ordinal",
      base: "worker",
      instanceName: "able-fox",
      ordinal: Number.NaN,
      expected: "worker able-fox",
    },
    {
      name: "omits hash for unbounded ordinal",
      base: "worker",
      instanceName: "able-fox",
      ordinal: Number.POSITIVE_INFINITY,
      expected: "worker able-fox",
    },
    {
      name: "falls back to base for unnamed instance",
      base: "worker",
      instanceName: undefined,
      ordinal: 2,
      expected: "worker",
    },
    {
      name: "falls back to base for empty name with valid ordinal",
      base: "worker",
      instanceName: "",
      ordinal: 2,
      expected: "worker",
    },
    {
      name: "falls back to base for empty name without ordinal",
      base: "worker",
      instanceName: "",
      ordinal: undefined,
      expected: "worker",
    },
  ])("$name", ({ base, instanceName, ordinal, expected }) => {
    expect(formatDisplayIdentity(base, instanceName, ordinal)).toBe(expected);
  });

  test("styles only the ordinal segment", () => {
    expect(
      formatDisplayIdentity("worker", "able-fox", 2, (text) => `<${text}>`),
    ).toBe("worker <#2> able-fox");
  });
});

describe("T-002 innermost activity and tool-free thinking", () => {
  test("shows root tool without identity using space", () => {
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: ls -la" },
        80,
      ),
    ).toBe("bash ls -la");
  });

  test("shows direct child identity without nesting hint", () => {
    expect(
      renderActivityText(
        {
          toolName: "subagent",
          inputSummary: "subagent: build",
          instanceName: "swift-harbor",
          child: { toolName: "bash", inputSummary: "bash: make" },
        },
        80,
      ),
    ).toBe("build swift-harbor › bash make");
  });

  test("shows only innermost with ellipsis below direct child", () => {
    const result = renderActivityText(
      {
        toolName: "subagent",
        inputSummary: "subagent: plan",
        instanceName: "outer-inst",
        child: {
          toolName: "subagent",
          inputSummary: "subagent: build",
          instanceName: "inner-inst",
          child: { toolName: "bash", inputSummary: "bash: make test" },
        },
      },
      80,
    );
    expect(result).toBe("… › build inner-inst › bash make test");
    expect(result).not.toContain("outer-inst");
    expect(result).not.toContain("plan");
  });

  test("omits absent instance and ordinal without instance", () => {
    expect(
      renderActivityText(
        {
          toolName: "subagent",
          inputSummary: "subagent: build",
          child: { toolName: "bash", inputSummary: "bash: ls" },
        },
        80,
      ),
    ).toBe("build › bash ls");
    expect(
      renderActivityText(
        {
          toolName: "subagent",
          inputSummary: "subagent: build",
          ordinal: 3,
          child: { toolName: "bash", inputSummary: "bash: ls" },
        },
        80,
      ),
    ).toBe("build › bash ls");
  });

  test("shows ordinal only with instance and safe integer at least two", () => {
    expect(
      renderActivityText(
        {
          toolName: "subagent",
          inputSummary: "subagent: build",
          instanceName: "able-fox",
          ordinal: 2,
          child: { toolName: "bash", inputSummary: "bash: ls" },
        },
        80,
      ),
    ).toBe("build #2 able-fox › bash ls");
    expect(
      renderActivityText(
        {
          toolName: "subagent",
          inputSummary: "subagent: build",
          instanceName: "able-fox",
          ordinal: 1,
          child: { toolName: "bash", inputSummary: "bash: ls" },
        },
        80,
      ),
    ).toBe("build able-fox › bash ls");
  });

  test("renders unnamed delegation hop as tool subagent", () => {
    expect(
      renderActivityText(
        { toolName: "subagent", inputSummary: "subagent" },
        80,
      ),
    ).toBe("subagent");
    const withChild = renderActivityText(
      {
        toolName: "subagent",
        inputSummary: "subagent",
        child: { toolName: "bash", inputSummary: "bash: ls" },
      },
      80,
    );
    expect(withChild).toBe("bash ls");
  });

  test("splits flattened tool text only at first colon space", () => {
    expect(
      renderActivityText(
        { toolName: "tool", inputSummary: "bash: ls: verbose" },
        80,
      ),
    ).toBe("bash ls: verbose");
    expect(
      renderActivityText({ toolName: "tool", inputSummary: "bash ls" }, 80),
    ).toBe("bash ls");
  });

  test("never infers identity from flattened subagent text", () => {
    expect(
      renderActivityText(
        { toolName: "tool", inputSummary: "subagent: build" },
        80,
      ),
    ).toBe("subagent build");
  });

  test("replaces only sensitive target and preserves agent and tool names", () => {
    expect(
      renderActivityText(
        {
          toolName: "subagent",
          inputSummary: "subagent: secret-agent",
          instanceName: "token-instance",
          child: { toolName: "token", inputSummary: "token: secret-value" },
        },
        80,
      ),
    ).toBe("secret-agent token-instance › token (hidden)");
  });

  test("clips stored placeholder as hidden within narrow budgets", () => {
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "(running...)" },
        80,
      ),
    ).toBe("(hidden)");
    expect(
      renderActivityText({ toolName: "bash", inputSummary: "(running...)" }, 7),
    ).toBe("(hidde…");
    expect(
      renderActivityText({ toolName: "bash", inputSummary: "(running...)" }, 4),
    ).toBe("(hi…");
  });

  test("clips hidden placeholder without leaking sensitive text", () => {
    const result = renderActivityText(
      { toolName: "tool", inputSummary: "my-secret-thing" },
      4,
    );
    expect(result).toBe("(hi…");
    expect(result).not.toContain("secret");
  });

  test("renders flattened sensitive text without delimiter as hidden", () => {
    expect(
      renderActivityText(
        { toolName: "tool", inputSummary: "my-secret-thing" },
        80,
      ),
    ).toBe("(hidden)");
  });

  test("keeps sanitized bare tool name target-free", () => {
    expect(
      renderActivityText({ toolName: "bash", inputSummary: "bash" }, 80),
    ).toBe("bash");
  });

  test.each([
    {
      name: "drops an empty flattened remainder after a delimiter",
      toolName: "grep",
      inputSummary: "other: ",
    },
    {
      name: "keeps the tool name when the summary is whitespace-only",
      toolName: "grep",
      inputSummary: "   ",
    },
  ])("$name", ({ toolName, inputSummary }) => {
    expect(renderActivityText({ toolName, inputSummary }, 80)).toBe(toolName);
  });

  test("extracts a non-prefix colon remainder as the target", () => {
    expect(
      renderActivityText(
        { toolName: "read", inputSummary: "target: /etc/hosts" },
        80,
      ),
    ).toBe("read /etc/hosts");
  });

  test("treats a colon-free summary differing from the tool as the target", () => {
    expect(
      renderActivityText({ toolName: "read", inputSummary: "/etc/hosts" }, 80),
    ).toBe("read /etc/hosts");
  });

  test("keeps a flattened summary starting with a delimiter as the tool", () => {
    expect(
      renderActivityText({ toolName: "tool", inputSummary: ": leftover" }, 80),
    ).toBe(": leftover");
  });

  test("falls back to the tool name when a flattened summary normalizes to nothing", () => {
    expect(
      renderActivityText({ toolName: "tool", inputSummary: "   " }, 80),
    ).toBe("tool");
  });

  test("renders a subagent summary with an empty agent as a plain tool", () => {
    expect(
      renderActivityText(
        { toolName: "subagent", inputSummary: "subagent: " },
        80,
      ),
    ).toBe("subagent");
  });

  test("renders delegate without tool as thinking", () => {
    expect(
      renderActivityText(
        {
          toolName: "subagent",
          inputSummary: "subagent: build",
          instanceName: "swift-harbor",
        },
        80,
      ),
    ).toBe("build swift-harbor › thinking");
  });

  test("renders nested delegate without tool with ellipsis thinking", () => {
    expect(
      renderActivityText(
        {
          toolName: "subagent",
          inputSummary: "subagent: outer",
          instanceName: "outer-inst",
          child: {
            toolName: "subagent",
            inputSummary: "subagent: inner",
            instanceName: "inner-inst",
          },
        },
        80,
      ),
    ).toBe("… › inner inner-inst › thinking");
  });

  test("keeps root tool and target roles when the target contains a separator", () => {
    expect(
      renderToolActivityPieces(
        { toolName: "bash", inputSummary: "bash: echo a › b" },
        80,
      ),
    ).toEqual([
      { role: "tool", text: "bash" },
      { role: "target", text: " echo a › b" },
    ]);
  });

  test("keeps a tool named thinking in the tool role", () => {
    expect(
      renderToolActivityPieces(
        { toolName: "thinking", inputSummary: "thinking" },
        80,
      ),
    ).toEqual([{ role: "tool", text: "thinking" }]);
  });

  test("keeps a literal hidden target in the target role", () => {
    expect(
      renderToolActivityPieces(
        { toolName: "bash", inputSummary: "bash: (hidden)" },
        80,
      ),
    ).toEqual([
      { role: "tool", text: "bash" },
      { role: "target", text: " (hidden)" },
    ]);
  });

  test("reserves the inferred role for protected targets and tool-free work", () => {
    expect(
      renderToolActivityPieces(
        { toolName: "bash", inputSummary: "bash: secret-value" },
        80,
      ),
    ).toEqual([
      { role: "tool", text: "bash" },
      { role: "plain", text: " " },
      { role: "inferred", text: "(hidden)" },
    ]);
    expect(
      renderToolActivityPieces(
        {
          toolName: "subagent",
          inputSummary: "subagent: build",
          instanceName: "swift-harbor",
          ordinal: 2,
        },
        80,
      ),
    ).toEqual([
      { role: "agent", text: "build" },
      { role: "plain", text: " " },
      { role: "ordinal", text: "#2" },
      { role: "plain", text: " " },
      { role: "instance", text: "swift-harbor" },
      { role: "plain", text: " " },
      { role: "mark", text: "›" },
      { role: "plain", text: " " },
      { role: "inferred", text: "thinking" },
    ]);
  });

  test("keeps the target role when the budget clips a target", () => {
    const pieces = renderToolActivityPieces(
      { toolName: "bash", inputSummary: "bash: echo alpha beta gamma" },
      12,
    );
    expect(pieces?.map((piece) => piece.text).join("")).toBe("bash echo a…");
    expect(pieces?.at(-1)).toEqual({ role: "target", text: " echo a…" });
  });

  test("display parsing never mutates structured activity", () => {
    const activity: ToolActivity = {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      ordinal: 2,
      child: { toolName: "bash", inputSummary: "bash: secret-value" },
    };
    const snapshot = JSON.parse(JSON.stringify(activity));
    renderActivityText(activity, 10);
    expect(activity).toEqual(snapshot);
  });

  test("storage retains colon hops joined by separator and whole-line redaction", () => {
    expect(
      renderToolActivity({
        toolName: "subagent",
        inputSummary: "subagent: build",
        instanceName: "swift-harbor",
        child: { toolName: "bash", inputSummary: "bash: make" },
      }),
    ).toBe("subagent: build swift-harbor - bash: make");
    expect(
      renderToolActivity({
        toolName: "bash",
        inputSummary: "bash: secret-token",
      }),
    ).toBe("(running...)");
  });
});

describe("T-003 Protect, shorten, and bound activity targets", () => {
  function pathAnchors(cwd: string, home: string): PathAnchors {
    return { cwd: () => cwd, home: () => home };
  }

  test("shortens single-token absolute path relative to cwd", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: /repo/src/file.ts" },
        80,
        anchors,
      ),
    ).toBe("bash src/file.ts");
  });

  test("maps cwd itself to dot and home itself to tilde", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: /repo" },
        80,
        anchors,
      ),
    ).toBe("bash .");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: /home/user" },
        80,
        anchors,
      ),
    ).toBe("bash ~");
  });

  test("prefers cwd over home when both match", () => {
    const anchors = pathAnchors("/home/user/repo", "/home/user");
    expect(
      renderActivityText(
        {
          toolName: "bash",
          inputSummary: "bash: /home/user/repo/file.ts",
        },
        80,
        anchors,
      ),
    ).toBe("bash file.ts");
  });

  test("shortens to tilde when under home but outside cwd", () => {
    const anchors = pathAnchors("/tmp/work", "/home/user");
    expect(
      renderActivityText(
        {
          toolName: "bash",
          inputSummary: "bash: /home/user/docs/file.txt",
        },
        80,
        anchors,
      ),
    ).toBe("bash ~/docs/file.txt");
  });

  test("leaves absolute unchanged outside cwd and home", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: /etc/hosts" },
        80,
        anchors,
      ),
    ).toBe("bash /etc/hosts");
  });

  test("respects directory boundaries for cwd prefix", () => {
    const anchors = pathAnchors("/foo/bar", "/home/user");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: /foo/barbaz/file" },
        80,
        anchors,
      ),
    ).toBe("bash /foo/barbaz/file");
  });

  test.each([
    {
      name: "keeps absolute target resolving outside cwd and home",
      cwd: "/repo/work",
      home: "/home/user",
      target: "/repo/work/../outside.txt",
    },
    {
      name: "keeps absolute target resolving outside home",
      cwd: "/tmp/work",
      home: "/home/user",
      target: "/home/user/../etc/hosts",
    },
  ])("$name", ({ cwd, home, target }) => {
    const anchors = pathAnchors(cwd, home);
    expect(
      renderActivityText(
        { toolName: "read", inputSummary: `read: ${target}` },
        80,
        anchors,
      ),
    ).toBe(`read ${target}`);
  });

  test("shortens absolute target resolving inside cwd", () => {
    const anchors = pathAnchors("/repo/work", "/home/user");
    expect(
      renderActivityText(
        {
          toolName: "bash",
          inputSummary: "bash: /repo/work/sub/../file.txt",
        },
        80,
        anchors,
      ),
    ).toBe("bash file.txt");
  });

  test("preserves multi-token targets and embedded paths", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    expect(
      renderActivityText(
        {
          toolName: "bash",
          inputSummary: "bash: echo /repo/src/file.ts",
        },
        80,
        anchors,
      ),
    ).toBe("bash echo /repo/src/file.ts");
    expect(
      renderActivityText(
        {
          toolName: "bash",
          inputSummary: "bash: cat /repo/file.ts --flag",
        },
        80,
        anchors,
      ),
    ).toBe("bash cat /repo/file.ts --flag");
  });

  test("preserves protection through shortening and keeps bare tool target-free", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    expect(
      renderActivityText(
        {
          toolName: "bash",
          inputSummary: "bash: /repo/secret-token.yaml",
        },
        80,
        anchors,
      ),
    ).toBe("bash (hidden)");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash" },
        80,
        anchors,
      ),
    ).toBe("bash");
  });

  test("applies complete width bounds to hidden text", () => {
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: secret-value" },
        13,
      ),
    ).toBe("bash (hidden)");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: secret-value" },
        7,
      ),
    ).toBe("bash");
  });

  test("shortens path tail behind ellipsis including filename", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    const activity: ToolActivity = {
      toolName: "bash",
      inputSummary: "bash: /very/long/path/to/filename.txt",
    };
    const result = renderActivityText(activity, 20, anchors);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain("filename.txt");
    expect(result).toContain("…");
    expect(result.startsWith("bash ")).toBe(true);
  });

  test("retains head for non-path targets", () => {
    const activity: ToolActivity = {
      toolName: "bash",
      inputSummary: "bash: this-is-a-very-long-command-argument",
    };
    const result = renderActivityText(activity, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain("this-is");
    expect(result).toMatch(/…$/);
  });

  test("drops target before identity when budget is tight", () => {
    const activity: ToolActivity = {
      toolName: "subagent",
      inputSummary: "subagent: build-task-with-long-description",
      child: {
        toolName: "bash",
        inputSummary: "bash: make-build-with-verbose-output",
      },
    };
    const result = renderActivityText(activity, 40);
    expect(result).toBe("build-task-with-long-description › bash");
  });

  test("retains path tail behind ellipsis when filename cannot fit", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    const activity: ToolActivity = {
      toolName: "bash",
      inputSummary: "bash: /a/very-long-filename-that-exceeds-budget.txt",
    };
    expect(renderActivityText(activity, 12, anchors)).toBe("bash …et.txt");
    expect(renderActivityText(activity, 5, anchors)).toBe("bash");
  });

  test("retains complete filename at the exact fit boundary", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    const activity: ToolActivity = {
      toolName: "bash",
      inputSummary: "bash: /very/long/path/to/filename.txt",
    };
    expect(renderActivityText(activity, 18, anchors)).toBe(
      "bash …filename.txt",
    );
  });

  test("truncates whole line only after dropping target", () => {
    const activity: ToolActivity = {
      toolName: "bash-long-tool-name-that-keeps-going",
      inputSummary: "bash-long-tool-name-that-keeps-going: target",
    };
    const result = renderActivityText(activity, 15);
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result).toMatch(/…$/);
    expect(result).toContain("bash-long");
  });

  test("never exceeds budget for wide and combining text", () => {
    const wide = "あ".repeat(20);
    const wideResult = renderActivityText(
      { toolName: "bash", inputSummary: `bash: ${wide}` },
      20,
    );
    expect(visibleWidth(wideResult)).toBeLessThanOrEqual(20);
    const combining = "a\u0301".repeat(20);
    const combiningResult = renderActivityText(
      { toolName: "bash", inputSummary: `bash: ${combining}` },
      20,
    );
    expect(visibleWidth(combiningResult)).toBeLessThanOrEqual(20);
  });

  test("handles zero and narrow budgets without overflow", () => {
    expect(
      renderActivityText({ toolName: "bash", inputSummary: "bash: ls" }, 0),
    ).toBe("");
    const narrow = renderActivityText(
      { toolName: "bash", inputSummary: "bash: ls" },
      5,
    );
    expect(narrow.length).toBeLessThanOrEqual(5);
  });

  test("never leaks sensitive targets through shortening or overflow", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    const activity: ToolActivity = {
      toolName: "bash",
      inputSummary: "bash: /repo/secret-file-path-with-long-name.txt",
    };
    for (const budget of [80, 20, 12, 8]) {
      const result = renderActivityText(activity, budget, anchors);
      expect(result).not.toContain("secret");
    }
    expect(renderActivityText(activity, 80, anchors)).toBe("bash (hidden)");
  });

  test("leaves activity input and stored previews unchanged", () => {
    const anchors = pathAnchors("/repo", "/home/user");
    const activity: ToolActivity = {
      toolName: "bash",
      inputSummary: "bash: /repo/src/file.ts",
    };
    const snapshot = JSON.parse(JSON.stringify(activity));
    renderActivityText(activity, 10, anchors);
    expect(activity).toEqual(snapshot);
    expect(
      renderToolActivity({
        toolName: "bash",
        inputSummary: "bash: /repo/src/file.ts",
      }),
    ).toBe("bash: /repo/src/file.ts");
  });

  test("shortens absolute targets when cwd is the filesystem root", () => {
    const anchors = pathAnchors("/", "/home/user");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: /etc/hosts" },
        80,
        anchors,
      ),
    ).toBe("bash etc/hosts");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: /usr/bin/env" },
        80,
        anchors,
      ),
    ).toBe("bash usr/bin/env");
  });

  test("shortens under home when home is the filesystem root", () => {
    const anchors = pathAnchors("/tmp/work", "/");
    expect(
      renderActivityText(
        { toolName: "bash", inputSummary: "bash: /etc/hosts" },
        80,
        anchors,
      ),
    ).toBe("bash ~/etc/hosts");
  });

  test("keeps the target unchanged when cwd and homedir resolution fail", () => {
    const originalCwd = process.cwd;
    const originalHomeEnv = process.env["HOME"];
    const originalHomedir = realOs.homedir;
    (process as unknown as { cwd: () => string }).cwd = () => {
      throw new Error("no cwd");
    };
    delete process.env["HOME"];
    mock.module("node:os", () => ({
      ...realOs,
      homedir: () => {
        throw new Error("no home");
      },
    }));
    try {
      expect(
        renderActivityText(
          { toolName: "read", inputSummary: "read: /etc/hosts" },
          80,
        ),
      ).toBe("read /etc/hosts");
    } finally {
      (process as unknown as { cwd: () => string }).cwd = originalCwd;
      if (originalHomeEnv === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHomeEnv;
      mock.module("node:os", () => ({
        ...realOs,
        homedir: originalHomedir,
      }));
    }
  });

  test("shortens under the homedir fallback when HOME is empty", () => {
    const originalCwd = process.cwd;
    const originalHomeEnv = process.env["HOME"];
    const originalHomedir = realOs.homedir;
    (process as unknown as { cwd: () => string }).cwd = () => "/tmp/work";
    process.env["HOME"] = "";
    mock.module("node:os", () => ({
      ...realOs,
      homedir: () => "/home/fallback-user",
    }));
    try {
      expect(
        renderActivityText(
          {
            toolName: "bash",
            inputSummary: "bash: /home/fallback-user/docs/a.txt",
          },
          80,
        ),
      ).toBe("bash ~/docs/a.txt");
    } finally {
      (process as unknown as { cwd: () => string }).cwd = originalCwd;
      if (originalHomeEnv === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHomeEnv;
      mock.module("node:os", () => ({
        ...realOs,
        homedir: originalHomedir,
      }));
    }
  });

  test("clips a trailing-slash path target at its tail", () => {
    expect(
      renderActivityText({ toolName: "bash", inputSummary: "bash: a/b/" }, 8),
    ).toBe("bash …b/");
  });

  test("drops a target with no room beyond its ellipsis", () => {
    expect(
      renderActivityText({ toolName: "bash", inputSummary: "bash: a/b/c" }, 6),
    ).toBe("bash");
  });
});
