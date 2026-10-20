import { describe, expect, test } from "bun:test";
import { formatElapsed, formatHeaderStats } from "../src/progress/progress.js";
import {
  formatContextPercent,
  renderToolActivity,
  renderToolActivityForDisplay,
  SENSITIVE_PATTERN,
} from "../src/progress/progress-format.js";
import type { ToolActivity } from "../src/shared/types.js";

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
  withDateNow(4000, () => {
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
  });
});

test("withDateNow restores captured Date.now reference after normal return", () => {
  const previousNow = Date.now;
  withDateNow(4000, () => {
    expect(Date.now()).toBe(4000);
  });
  expect(Date.now).toBe(previousNow);
});

test("withDateNow restores captured Date.now reference when the scope throws deliberately", () => {
  const previousNow = Date.now;
  const deliberate = new Error("deliberate clock-scope throw");
  let caught: unknown;
  try {
    withDateNow(4000, () => {
      expect(Date.now()).toBe(4000);
      throw deliberate;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(deliberate);
  expect(Date.now).toBe(previousNow);
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

function withDateNow<T>(now: number, run: () => T): T {
  const previousNow = Date.now;
  Date.now = () => now;
  try {
    return run();
  } finally {
    Date.now = previousNow;
  }
}
