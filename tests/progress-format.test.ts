import { describe, expect, jest, test } from "bun:test";
import { formatElapsed, formatHeaderStats } from "../src/progress/progress.js";
import {
  formatContextPercent,
  formatDescendantTally,
  formatUsageTree,
  renderToolActivity,
  renderToolActivityForDisplay,
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
    expect(formatHeaderStats(base)).toBe("0 tools · --% ctx · 3.0s");
    expect(
      formatHeaderStats({
        ...base,
        contextTokens: -1,
        contextWindowTokens: 100,
      }),
    ).toBe("0 tools · 0% ctx · 3.0s");
    expect(
      formatHeaderStats({
        ...base,
        contextTokens: Number.NaN,
        contextWindowTokens: 100,
      }),
    ).toBe("0 tools · 0% ctx · 3.0s");
    expect(
      formatHeaderStats({ ...base, contextTokens: 50, contextWindowTokens: 0 }),
    ).toBe("0 tools · --% ctx · 3.0s");
    expect(
      formatHeaderStats({
        ...base,
        contextTokens: 50,
        contextWindowTokens: Number.POSITIVE_INFINITY,
      }),
    ).toBe("0 tools · --% ctx · 3.0s");
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
  ).toBe("subagent: build [swift-harbor]");
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
  ).toBe("subagent: build [swift-harbor] - bash: make build");
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
    "subagent: plan [outer-inst] - subagent: build [inner-inst] - bash: make test",
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

test("renderToolActivityForDisplay returns undefined for undefined activity", () => {
  expect(renderToolActivityForDisplay(undefined, 80)).toBeUndefined();
});

test("renderToolActivityForDisplay returns toolName when no inputSummary", () => {
  expect(renderToolActivityForDisplay({ toolName: "bash" }, 80)).toBe("bash");
});

test.each([
  {
    name: "renderToolActivityForDisplay renders depth-1 with budget",
    inputSummary: "ls -la",
    budget: 80,
    expected: "ls -la",
  },
  {
    name: "renderToolActivityForDisplay returns empty string for zero budget",
    inputSummary: "bash: ls",
    budget: 0,
    expected: "",
  },
])("$name", (row) => {
  expect(
    renderToolActivityForDisplay(
      { toolName: "bash", inputSummary: row.inputSummary },
      row.budget,
    ),
  ).toBe(row.expected);
});

test("renderToolActivityForDisplay truncates joined result once not segments independently", () => {
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
  const result = renderToolActivityForDisplay(activity, 80);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(80);
  expect(result).toContain("first-segment");
  expect(result).toContain("second-segment");
  expect(result).toMatch(/…$/);
});

test("renderToolActivityForDisplay preserves full text when within budget", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "short-one",
    child: {
      toolName: "bash",
      inputSummary: "short-two",
    },
  };
  expect(renderToolActivityForDisplay(activity, 80)).toBe(
    "short-one - short-two",
  );
});

test("renderToolActivityForDisplay redacts sensitive keywords in joined text", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading config",
    child: {
      toolName: "bash",
      inputSummary: "secret-token.yaml",
    },
  };
  expect(renderToolActivityForDisplay(activity, 80)).toBe("(running...)");
});

test("renderToolActivityForDisplay annotates instanceName before joining", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "parent-task",
    instanceName: "alpha",
    child: {
      toolName: "bash",
      inputSummary: "child-task",
    },
  };
  expect(renderToolActivityForDisplay(activity, 80)).toBe(
    "parent-task [alpha] - child-task",
  );
});

test("renderToolActivityForDisplay applies tight budget correctly", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "this-is-a-very-long-first-segment",
    child: {
      toolName: "bash",
      inputSummary: "this-is-a-very-long-second-segment",
    },
  };
  const result = renderToolActivityForDisplay(activity, 30);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(30);
  expect(result).toMatch(/…$/);
});

test("renderToolActivityForDisplay respects narrow width budget", () => {
  const activity: ToolActivity = {
    toolName: "bash",
    inputSummary:
      "bash: this-is-a-very-long-command-that-exceeds-narrow-budget",
  };
  const result = renderToolActivityForDisplay(activity, 20);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(20);
  expect(result).toMatch(/…$/);
});

test("renderToolActivityForDisplay returns empty string for negative budget", () => {
  expect(
    renderToolActivityForDisplay(
      { toolName: "bash", inputSummary: "bash: ls" },
      -5,
    ),
  ).toBe("");
});

test("renderToolActivityForDisplay returns empty string for zero budget with sensitive text", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading secret-token.yaml",
  };
  expect(renderToolActivityForDisplay(activity, 0)).toBe("");
});

test("renderToolActivityForDisplay redacts sensitive text only when budget fits (running...)", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading config",
    child: { toolName: "bash", inputSummary: "cat secret-token.yaml" },
  };
  expect(renderToolActivityForDisplay(activity, 12)).toBe("(running...)");
  expect(renderToolActivityForDisplay(activity, 11)).toBe("");
});

test("renderToolActivityForDisplay handles very narrow budget gracefully", () => {
  const activity: ToolActivity = {
    toolName: "bash",
    inputSummary: "bash: command",
  };
  const result = renderToolActivityForDisplay(activity, 5);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(5);
});

test("renderToolActivityForDisplay truncates nested activity at narrow width", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "subagent: build-task-with-long-description",
    child: {
      toolName: "bash",
      inputSummary: "bash: make-build-with-verbose-output",
    },
  };
  const result = renderToolActivityForDisplay(activity, 40);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(40);
  expect(result).toContain("subagent");
  expect(result).toMatch(/…$/);
});

test("sensitive activity redaction applies to joined display text", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading config",
    child: {
      toolName: "bash",
      inputSummary: "bash: cat secret-token.yaml",
    },
  };
  const result = renderToolActivityForDisplay(activity, 80);
  expect(result).toBe("(running...)");
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
  test("hides ordinal 1 preserving bracketed instance annotation", () => {
    expect(
      renderToolActivity({
        toolName: "subagent",
        inputSummary: "subagent: build",
        instanceName: "swift-harbor",
        ordinal: 1,
      }),
    ).toBe("subagent: build [swift-harbor]");
  });

  test("inserts #ordinal for ordinal >=2 preserving brackets", () => {
    expect(
      renderToolActivity({
        toolName: "subagent",
        inputSummary: "subagent: build",
        instanceName: "brave-otter",
        ordinal: 3,
      }),
    ).toBe("subagent: build [#3 brave-otter]");
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
      "subagent: plan [#2 outer-inst] - subagent: build [inner-inst] - bash: make test",
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

  test("display rendering honors ordinal threshold and budget", () => {
    const activity: ToolActivity = {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "brave-otter",
      ordinal: 2,
    };
    expect(renderToolActivityForDisplay(activity, 80)).toBe(
      "subagent: build [#2 brave-otter]",
    );
    expect(
      renderToolActivityForDisplay(
        {
          toolName: "subagent",
          inputSummary: "subagent: build",
          instanceName: "brave-otter",
          ordinal: 1,
        },
        80,
      ),
    ).toBe("subagent: build [brave-otter]");
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
    expect(tally).toContain("build 1\u2713");
    expect(tally).toContain("wrap 1\u2713");
  });
  test("includes omitted contributions exactly once omitting cost", () => {
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
    expect(tally).toContain("build 1\u2713");
    expect(tally).toContain("spec 1\u2713");
    expect(tally).not.toContain("$");
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
      "1 spawned \u00b7 fix 1\u2713",
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
    expect(tally).toBe("2 spawned \u00b7 build 2 (1\u2713 1\u27f3)");
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
    const narrow = formatDescendantTally(root, 22);
    expect(narrow).toBeDefined();
    expect(narrow).toMatch(/\+\d+ more/);
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
    expect(formatDescendantTally(root, 19)).toBe(
      "1 spawned \u00b7 \u732b\u732b 1\u2713",
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
  test("shows ordinal 1 in tree nodes", () => {
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
    expect(lines.some((line) => line.includes("#1 leaf"))).toBe(true);
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
      lines.some((line) => line.includes("live") && line.includes("2.5s")),
    ).toBe(true);
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
    expect(line).toBe("\u2713 build #1 nodur");
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
      nanNow.some((line) => line.includes("live") && line.includes("0.0s")),
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
      badLines.some((line) => line.includes("bad") && line.includes("0.0s")),
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
    expect(joined.indexOf("\u2713 beta #1 other")).toBeLessThan(
      joined.indexOf("\u2717 beta #1 other"),
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
