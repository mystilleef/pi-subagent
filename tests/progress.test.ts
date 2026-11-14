import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  attachChildSubtree,
  queryInstanceUsage,
  registerRootInstance,
  resetUsageLedger,
} from "../src/orchestration/usage-ledger.js";
import type { SubagentTheme } from "../src/output/ui.js";
import {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  makeToolPreview,
  markProgressResultPosted,
  patchProgressState,
  renderSubagentProgress,
} from "../src/progress/progress.js";
import { formatDescendantTally } from "../src/progress/progress-format.js";
import type { ProgressStatus } from "../src/progress/progress-state.js";
import type { ToolActivity, UsageInstanceNode } from "../src/shared/types.js";

afterEach(() => {
  jest.useRealTimers();
  clearProgressState("req-1");
  clearProgressState("req-2");
  clearProgressState("rend-live");
  clearProgressState("iso-success");
  clearProgressState("iso-error");
  clearProgressState("iso-running");
  for (let i = 1; i <= 12; i++) clearProgressState(`rend-${i}`);
  clearProgressState("inv-1");
});

describe("unconfirmed thinking progress propagation", () => {
  test("renderSubagentProgress shows requested level in progress box", () => {
    createProgressState("req-1", "agent-a", "task a");
    patchProgressState("req-1", { modelDisplay: "unknown ･ unknown ･ high" });
    const rendered = renderSubagentProgress(
      {
        customType: "subagent-progress",
        content: "",
        display: true,
        details: { requestId: "req-1" },
      },
      { expanded: false },
      makeTheme(),
    );
    expect(renderText(rendered)).toContain("unknown ･ unknown ･ high");
  });
});

function makeTheme() {
  return {
    fg: (_color: ThemeColor, text: string) => text,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };
}

function makeMarkerTheme() {
  return {
    fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => text,
    italic: (text: string) => `<italic>${text}</italic>`,
    underline: (text: string) => `<underline>${text}</underline>`,
    strikethrough: (text: string) => `<strike>${text}</strike>`,
  };
}

function renderLines(
  rendered: { render(width: number): string[] } | undefined,
): string[] {
  if (!rendered) return [];
  return rendered.render(120);
}

function renderLinesAtWidth(
  rendered: { render(width: number): string[] } | undefined,
  width: number,
): string[] {
  if (!rendered) return [];
  return rendered.render(width);
}

function stripAnsiAndWrappers(text: string): string {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return text
    .replace(ansiPattern, "")
    .replace(/\[(?:toolPendingBg|toolSuccessBg|toolErrorBg)\]/g, "")
    .replace(/\[\/(?:toolPendingBg|toolSuccessBg|toolErrorBg)\]/g, "");
}

function renderText(
  rendered: { render(width: number): string[] } | undefined,
): string {
  return renderLines(rendered).join("\n");
}

/** Renders a running card for `activity` on fresh state, then clears it. */
function renderActivityCard(
  requestId: string,
  activity?: ToolActivity,
  {
    theme = makeMarkerTheme(),
    width = 120,
  }: { theme?: SubagentTheme; width?: number } = {},
): string[] {
  createProgressState(requestId, "agent", "task");
  try {
    if (activity)
      patchProgressState(requestId, { activeToolActivity: activity });
    const card = renderSubagentProgress(
      {
        customType: "subagent-progress",
        content: "",
        display: true,
        details: { requestId },
      },
      { expanded: false },
      theme,
    );
    if (!card) throw new Error(`progress card missing for ${requestId}`);
    return card.render(width);
  } finally {
    clearProgressState(requestId);
  }
}

function findActivityRow(lines: string[]): string {
  return lines.find((line) => line.includes("→")) ?? "";
}

test("renderSubagentProgress formats segmented agent and instance title", () => {
  createProgressState("rend-1", "my-agent", "do the thing", "able-falcon");
  const theme = {
    fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => `<bold>${text}</bold>`,
    italic: (text: string) => `<italic>${text}</italic>`,
    underline: (text: string) => `<underline>${text}</underline>`,
    strikethrough: (text: string) => `<strike>${text}</strike>`,
  };
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  const text = renderText(result);
  expect(text).toContain(
    "<toolTitle><bold>my-agent</bold></toolTitle> <accent><italic>able-falcon</italic></accent>",
  );
  expect(text).toContain("<muted>[running]</muted>");
  expect(text).toContain("<dim>0 tools · --% ctx ·");
});

test("renderSubagentProgress styles instance title through italic theme method", () => {
  createProgressState("rend-2", "my-agent", "do the thing", "able-falcon");
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: false },
    theme,
  );
  const text = renderText(result);
  expect(text).toContain("<toolTitle>my-agent</toolTitle>");
  expect(text).toContain("<accent><italic>able-falcon</italic></accent>");
  expect(text).toContain("<muted>[running]</muted>");
});

test("renderSubagentProgress keeps single title when instance is absent or empty", () => {
  createProgressState("rend-1", "my-agent", "do the thing", "");
  createProgressState("rend-2", "other-agent", "do the thing");
  patchProgressState("rend-2", {});
  const theme = makeMarkerTheme();
  const first = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  const second = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: false },
    theme,
  );
  const firstText = renderText(first);
  const secondText = renderText(second);
  expect(firstText).toContain(
    "<toolTitle>my-agent</toolTitle> <muted>[running]</muted>",
  );
  expect(firstText).not.toContain("my-agent  ");
  expect(firstText).not.toContain("\x1b[3m");
  expect(secondText).toContain(
    "<toolTitle>other-agent</toolTitle> <muted>[running]</muted>",
  );
  expect(secondText).not.toContain("other-agent  ");
  expect(secondText).not.toContain("\x1b[3m");
});

test("renderSubagentProgress collapsed running colors tool preview segments", () => {
  jest.setSystemTime(1000);
  createProgressState("rend-1", "my-agent", "do the thing", "rend-1");
  jest.setSystemTime(3500);
  patchProgressState("rend-1", {
    toolCount: 3,
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls -la" },
    lastToolPreview: "bash: ls -la",
    contextTokens: 18_000,
    contextWindowTokens: 240_000,
    inputTokens: 1200,
    outputTokens: 300,
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  const toolLine = renderLines(result).find((line) => line.includes("bash"));
  expect(text).toContain(
    "my-agent</toolTitle> <accent><italic>rend-1</italic></accent>",
  );
  expect(text).toContain("running");
  expect(text).toContain("3 tools");
  expect(text).toContain("8%");
  expect(text.indexOf("</italic></accent>")).toBeLessThan(
    text.indexOf("3 tools"),
  );
  expect(text).toContain("ctx · 2s");
  expect(text).not.toContain("1.2k in");
  expect(text).not.toContain("300 out");
  expect(text).not.toContain("1.2k in · 300 out · 8% ctx");
  expect(text).not.toContain("2 turns");
  expect(text).not.toContain("18k ctx");
  expect(toolLine).toStartWith(
    "[toolPendingBg]   <dim>→</dim> <text>bash</text><dim> ls -la</dim>",
  );
  expect(text).not.toContain("bash ls -la (");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolPendingBg]") && line.endsWith("[/toolPendingBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress collapsed running colors targetless tool preview", () => {
  createProgressState("rend-2", "my-agent", "do the thing");
  patchProgressState("rend-2", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash" },
    lastToolPreview: "bash",
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  const toolLine = renderLines(result).find((line) => line.includes("bash"));
  expect(toolLine).toStartWith(
    "[toolPendingBg]   <dim>→</dim> <text>bash</text>",
  );
  expect(toolLine).not.toContain("<dim>:");
  expect(toolLine).not.toContain("</text>:");
  expect(text).not.toContain("do the thing");
});

test("renderSubagentProgress running omits unknown tool arguments", () => {
  createProgressState("rend-12", "my-agent", "do the thing");
  patchProgressState("rend-12", {
    activeToolActivity: {
      toolName: "unknown_tool",
      inputSummary: "unknown_tool",
    },
    lastToolPreview: makeToolPreview("unknown_tool", {
      token: "secret-token",
      password: "secret-password",
      nested: { value: "secret-nested" },
    }),
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-12" },
    },
    { expanded: false },
    theme,
  );
  const text = renderText(result);
  const toolLine = renderLines(result).find((line) =>
    line.includes("unknown_tool"),
  );
  expect(toolLine).toStartWith(
    "[toolPendingBg]   <dim>→</dim> <text>unknown_tool</text>",
  );
  expect(toolLine).not.toContain(":");
  expect(text).not.toContain("secret");
});

test("renderSubagentProgress expanded running includes truncated tool preview and full task preview", () => {
  const toolSentinel = "SHOULD_NOT_RENDER";
  const taskSentinel = "TASK_SHOULD_RENDER";
  const taskPreview = `do the thing ${taskSentinel}`;
  const longCommand = `${"x".repeat(160)}${toolSentinel}`;
  const lastToolPreview = makeToolPreview("bash", { command: longCommand });
  createProgressState("rend-2", "my-agent", taskPreview);
  patchProgressState("rend-2", {
    toolCount: 1,
    activeToolActivity: { toolName: "bash", inputSummary: lastToolPreview },
    lastToolPreview,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(lastToolPreview).toEndWith("…");
  expect(text).toContain("→ bash");
  expect(text).toContain("…");
  expect(text).toContain(taskPreview);
  expect(text.indexOf("\x1b[23m [running]")).toBeLessThan(
    text.indexOf(taskPreview),
  );
  expect(text).not.toContain(toolSentinel);
});

test("renderSubagentProgress component reads patched state on later renders", () => {
  createProgressState("rend-live", "live-agent", "live task");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-live" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(result)).toContain("0 tools · --% ctx");
  patchProgressState("rend-live", {
    toolCount: 2,
    activeToolActivity: { toolName: "bash", inputSummary: "bash: pwd" },
    lastToolPreview: "bash: pwd",
    contextTokens: 10_000,
    inputTokens: 1200,
    outputTokens: 300,
  });
  const text = renderText(result);
  expect(text).toContain("2 tools · --% ctx");
  expect(text).not.toContain("1.2k in");
  expect(text).not.toContain("300 out");
  expect(text).not.toContain("1.2k in · 300 out · --% ctx");
  expect(text).not.toContain("3 turns");
  expect(text).not.toContain("10k ctx");
  expect(text).not.toContain("1.2k in / 300 out");
  expect(text).toContain("→ bash pwd");
  expect(text).not.toContain("bash pwd (");
});

type FooterCase = {
  state: string;
  expanded: boolean;
  task: string;
  modelDisplay: string;
  settle?: (requestId: string) => void;
  expected: string[];
};

test.each<FooterCase>([
  {
    state: "collapsed running",
    expanded: false,
    task: "model task",
    modelDisplay: "gemini-1.5-pro",
    expected: [],
  },
  {
    state: "expanded running",
    expanded: true,
    task: "model task",
    modelDisplay: "gemini-1.5-pro",
    settle: (requestId) =>
      patchProgressState(requestId, {
        activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
        lastToolPreview: "bash: ls",
      }),
    expected: ["model task", "bash ls"],
  },
  {
    state: "collapsed error",
    expanded: false,
    task: "error task",
    modelDisplay: "claude-3-5-sonnet",
    settle: (requestId) => failProgressState(requestId, "something exploded"),
    expected: ["something exploded"],
  },
  {
    state: "expanded error",
    expanded: true,
    task: "error task",
    modelDisplay: "claude-3-5-sonnet",
    settle: (requestId) => failProgressState(requestId, "something exploded"),
    expected: ["something exploded", "error task"],
  },
  {
    state: "collapsed cancelled",
    expanded: false,
    task: "cancel task",
    modelDisplay: "gpt-4o",
    settle: (requestId) => cancelProgressState(requestId, "user cancelled"),
    expected: ["cancelled"],
  },
  {
    state: "expanded cancelled",
    expanded: true,
    task: "cancel task",
    modelDisplay: "gpt-4o",
    settle: (requestId) => cancelProgressState(requestId, "user cancelled"),
    expected: ["cancel task"],
  },
  {
    state: "collapsed success",
    expanded: false,
    task: "success task",
    modelDisplay: "provider/model:compact",
    settle: (requestId) => finalizeProgressState(requestId, "all done"),
    expected: ["all done"],
  },
  {
    state: "expanded success",
    expanded: true,
    task: "success task",
    modelDisplay: "provider/model:compact",
    settle: (requestId) => finalizeProgressState(requestId, "all done"),
    expected: ["success task", "all done"],
  },
])(
  "renderSubagentProgress renders modelDisplay footer for $state state",
  ({ state, expanded, task, modelDisplay, settle, expected }) => {
    const requestId = `rend-footer-${state}`;
    createProgressState(requestId, "footer-agent", task);
    settle?.(requestId);
    patchProgressState(requestId, { modelDisplay });
    const text = renderText(
      renderSubagentProgress(
        {
          customType: "subagent-progress",
          content: "",
          display: true,
          details: { requestId },
        },
        { expanded },
        makeTheme(),
      ),
    );
    for (const fragment of [modelDisplay, ...expected]) {
      expect(text).toContain(fragment);
    }
  },
);

test("renderSubagentProgress error state shows error text", () => {
  createProgressState("rend-3", "err-agent", "a task", "rend-3");
  failProgressState("rend-3", "something exploded");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-3" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("err-agent rend-3");
  expect(text).toContain("error");
  expect(text).toContain("something exploded");
  expect(text).not.toContain("FAILURE: something exploded");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress terminal renderer keeps compact state text", () => {
  createProgressState("rend-1", "ok-agent", "success task");
  finalizeProgressState(
    "rend-1",
    "Outcome: completed first line\nraw detail SHOULD_NOT_RENDER",
  );
  createProgressState("rend-2", "neutral-agent", "neutral task");
  finalizeProgressState(
    "rend-2",
    "Result: needs follow-up review\nraw detail SHOULD_NOT_RENDER",
  );
  const theme = makeTheme();
  const collapsed = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  const expanded = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: true },
    theme,
  );
  expect(renderText(collapsed)).toContain("completed first line");
  expect(renderText(expanded)).toContain("needs follow-up review");
  expect(renderText(collapsed)).not.toContain("SUCCESS:");
  expect(renderText(collapsed)).not.toContain("SHOULD_NOT_RENDER");
  expect(renderText(expanded)).not.toContain("SUCCESS:");
  expect(renderText(expanded)).not.toContain("SHOULD_NOT_RENDER");
});

test("renderSubagentProgress expanded success ignores patched raw multiline output", () => {
  createProgressState("rend-3", "ok-agent", "success task");
  finalizeProgressState("rend-3", "done");
  patchProgressState("rend-3", {
    finalOutput: "done\nraw detail SHOULD_NOT_RENDER",
    lastToolPreview: "SHOULD_NOT_RENDER_TOOL",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-3" },
    },
    { expanded: true },
    theme,
  );
  const text = renderText(result);
  expect(text).toContain("done");
  expect(text).not.toContain("SHOULD_NOT_RENDER");
  expect(text).not.toContain("SHOULD_NOT_RENDER_TOOL");
});

test("renderSubagentProgress final success with output uses text fallback when no Markdown", () => {
  createProgressState("rend-4", "ok-agent", "a task", "able-falcon");
  finalizeProgressState("rend-4", "final result text");
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-4" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("final result text");
  expect(text.indexOf("\x1b[23m</accent> <muted>[success]")).toBeLessThan(
    text.indexOf("final result text"),
  );
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolSuccessBg]") && line.endsWith("[/toolSuccessBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress cancelled state shows cancelled", () => {
  createProgressState("rend-5", "some-agent", "a task", "rend-5");
  cancelProgressState("rend-5", "user cancelled");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-5" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("some-agent rend-5");
  expect(text).toContain("cancelled");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress terminal states omit patched tool preview", () => {
  createProgressState("rend-10", "ok-agent", "success task");
  finalizeProgressState("rend-10", "final result text");
  patchProgressState("rend-10", { lastToolPreview: "SHOULD_NOT_RENDER" });
  createProgressState("rend-11", "err-agent", "error task");
  failProgressState("rend-11", "child failed");
  patchProgressState("rend-11", { lastToolPreview: "SHOULD_NOT_RENDER" });
  createProgressState("rend-12", "cancel-agent", "cancel task");
  cancelProgressState("rend-12", "user cancelled");
  patchProgressState("rend-12", { lastToolPreview: "SHOULD_NOT_RENDER" });
  const theme = makeTheme();
  for (const requestId of ["rend-10", "rend-11", "rend-12"]) {
    const result = renderSubagentProgress(
      {
        customType: "subagent-progress",
        content: "",
        display: true,
        details: { requestId },
      },
      { expanded: true },
      theme,
    );
    expect(renderText(result)).not.toContain("SHOULD_NOT_RENDER");
  }
});

test("renderSubagentProgress expanded error includes error text", () => {
  createProgressState("rend-6", "err-agent", "error task");
  failProgressState("rend-6", "child failed");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-6" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("error task");
  expect(text).toContain("child failed");
  expect(text).not.toContain("FAILURE:");
});

test("renderSubagentProgress freezes success elapsed after completion", () => {
  jest.setSystemTime(1000);
  createProgressState("rend-7", "ok-agent", "a task");
  jest.setSystemTime(2500);
  finalizeProgressState("rend-7", "final result text");
  jest.setSystemTime(9000);
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-7" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(result)).toContain("1.5s");
  expect(renderText(result)).not.toContain("8.0s");
});

test("renderSubagentProgress freezes error and cancelled elapsed after completion", () => {
  jest.setSystemTime(1000);
  createProgressState("rend-8", "err-agent", "error task");
  jest.setSystemTime(4000);
  failProgressState("rend-8", "child failed");
  jest.setSystemTime(10_000);
  const theme = makeTheme();
  const errorResult = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-8" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(errorResult)).toContain("3.0s");
  expect(renderText(errorResult)).not.toContain("9.0s");
  jest.setSystemTime(2000);
  createProgressState("rend-9", "cancel-agent", "cancel task");
  jest.setSystemTime(6500);
  cancelProgressState("rend-9", "user cancelled");
  jest.setSystemTime(12_000);
  const cancelResult = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-9" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(cancelResult)).toContain("4.5s");
  expect(renderText(cancelResult)).not.toContain("10.0s");
});

test("DynamicSubagentProgressText invalidate is a no-op", () => {
  createProgressState("inv-1", "agent", "task");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "inv-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  expect(() => result?.invalidate()).not.toThrow();
});

test("renderSubagentProgress unknown status renders header-only card", () => {
  createProgressState("inv-unknown", "agent", "task");
  patchProgressState("inv-unknown", { status: "unknown" as ProgressStatus });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "inv-unknown" },
    },
    { expanded: false },
    theme,
  );
  const lines = renderLines(result);
  // Header line inside the box padding; no body, tally, task, or footer.
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain("[unknown]");
  clearProgressState("inv-unknown");
});

test("cancelled progress without reason renders header-only card", () => {
  createProgressState("inv-no-reason", "agent", "cancel quietly");
  cancelProgressState("inv-no-reason");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "inv-no-reason" },
    },
    { expanded: false },
    theme,
  );
  const lines = renderLines(result);
  // Missing errorText suppresses the stopped body entirely.
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain("[cancelled]");
  expect(lines[1]).not.toContain("cancel quietly");
  clearProgressState("inv-no-reason");
});

test("running progress without tool activity renders thinking row", () => {
  createProgressState("inv-no-activity", "agent", "warming up");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "inv-no-activity" },
    },
    { expanded: false },
    theme,
  );
  const lines = renderLines(result);
  // Tool-free running intervals render thinking through the display budget.
  expect(lines[1]).toContain("[running]");
  expect(lines[1]).not.toContain("warming up");
  expect(renderText(result)).toContain("thinking");
  clearProgressState("inv-no-activity");
});

test("renderSubagentProgress keeps running elapsed live", () => {
  jest.setSystemTime(1000);
  createProgressState("rend-live", "live-agent", "live task");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-live" },
    },
    { expanded: false },
    theme,
  );
  jest.setSystemTime(2500);
  expect(renderText(result)).toContain("1s");
  jest.setSystemTime(5200);
  expect(renderText(result)).toContain("4s");
});

test("running progress renders long single activity as one line at narrow width", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "bash",
      inputSummary: `bash: ${"x".repeat(200)}`,
    },
    lastToolPreview: `bash: ${"x".repeat(200)}`,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 60);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(60);
  expect(toolLines[0]).toContain("…");
});
test("running progress renders nested activity chain as one line at medium width", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build-with-long-task-description",
      child: {
        toolName: "bash",
        inputSummary: "bash: make-build-with-verbose-compiler-output",
      },
    },
    lastToolPreview:
      "subagent: build-with-long-task-description - bash: make-build-with-verbose-compiler-output",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 80);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(80);
  expect(toolLines[0]).toContain("build-with-long-task-description");
  expect(toolLines[0]).toContain("bash");
  expect(toolLines[0]).toContain("›");
  expect(toolLines[0]).not.toContain("subagent:");
});
test("running progress handles very narrow render width without wrapping", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "bash",
      inputSummary: "bash: ls",
    },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 30);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(30);
});
test("running progress at width 120 keeps long activity within budget", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "bash",
      inputSummary: `bash: ${"x".repeat(150)}`,
    },
    lastToolPreview: `bash: ${"x".repeat(150)}`,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 120);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(120);
  expect(toolLines[0]).toContain("…");
});
test("collapsed running presentation preserves targetless tool formatting", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash" },
    lastToolPreview: "bash",
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const toolLine = renderLines(result).find((line) => line.includes("bash"));
  expect(toolLine).toStartWith(
    "[toolPendingBg]   <dim>→</dim> <text>bash</text>",
  );
  expect(toolLine).not.toContain("<dim>:");
});
test("expanded running presentation includes task preview on separate line", () => {
  createProgressState("rend-1", "agent", "do the important task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("do the important task");
  expect(text).toContain("→ bash ls");
  const lines = renderLines(result);
  const taskLineIndex = lines.findIndex((line) =>
    line.includes("do the important task"),
  );
  const toolLineIndex = lines.findIndex((line) => line.includes("→ bash ls"));
  expect(taskLineIndex).toBeGreaterThan(-1);
  expect(toolLineIndex).toBeGreaterThan(-1);
  expect(taskLineIndex).not.toBe(toolLineIndex);
});
test("header stats remain unchanged with width-aware preview", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    toolCount: 5,
    contextTokens: 50_000,
    contextWindowTokens: 200_000,
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("5 tools · 25% ctx ·");
});
test("status coloring remains unchanged with width-aware preview", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("<accent>⟳</accent>");
  expect(text).toContain("<muted>[running]</muted>");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolPendingBg]") && line.endsWith("[/toolPendingBg]"),
    ),
  ).toBe(true);
});
test("running progress omits activity row when render width leaves no budget", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines8 = renderLinesAtWidth(result, 8);
  expect(lines8.filter((line) => line.includes("→")).length).toBe(0);
  const lines7 = renderLinesAtWidth(result, 7);
  expect(lines7.filter((line) => line.includes("→")).length).toBe(0);
  const header = renderLinesAtWidth(result, 60).find((line) =>
    line.includes("running"),
  );
  expect(header).toBeDefined();
});
test("running progress truncates long toolName fallback at narrow positive width", () => {
  createProgressState("rend-1", "agent", "task");
  const longToolName = `very-long-tool-name-${"x".repeat(100)}`;
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: longToolName },
    lastToolPreview: longToolName,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const width = 25;
  const lines = renderLinesAtWidth(result, width);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(width);
  expect(toolLines[0]).toContain("…");
});
test.each([
  {
    name: "running progress omits activity row for long toolName fallback at zero budget",
    width: 8,
  },
  {
    name: "running progress omits activity row for long toolName fallback at no-row budget",
    width: 5,
  },
])("$name", (row) => {
  createProgressState("rend-1", "agent", "task");
  const longToolName = `very-long-tool-name-${"x".repeat(100)}`;
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: longToolName },
    lastToolPreview: longToolName,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, row.width);
  expect(lines.filter((line) => line.includes("→")).length).toBe(0);
});
test("running progress prevents toolName fallback wrapping at previously-wrapping widths", () => {
  createProgressState("rend-1", "agent", "task");
  const longToolName = `tool-with-very-long-name-${"z".repeat(80)}`;
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: longToolName },
    lastToolPreview: longToolName,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  for (const width of [15, 20, 25, 30, 40]) {
    const lines = renderLinesAtWidth(result, width);
    const toolLines = lines.filter((line) => line.includes("→"));
    expect(toolLines.length).toBeLessThanOrEqual(1);
    if (toolLines.length === 1) {
      const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
      expect(visibleText.length).toBeLessThanOrEqual(width);
    }
  }
});
test("running progress single activity stays within render width across sweep", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "bash",
      inputSummary: `bash: ${"x".repeat(200)}`,
    },
    lastToolPreview: `bash: ${"x".repeat(200)}`,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  for (const width of [10, 20, 40, 60, 80, 120]) {
    const lines = renderLinesAtWidth(result, width);
    const toolLines = lines.filter((line) => line.includes("→"));
    expect(toolLines.length).toBeLessThanOrEqual(1);
    if (toolLines.length === 1) {
      const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
      expect(visibleText.length).toBeLessThanOrEqual(width);
    }
  }
});
test("running progress nested activity chain stays within budget at very narrow widths", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build-with-long-description-here",
      child: {
        toolName: "bash",
        inputSummary: "bash: make-build-verbose-compiler-output-here",
      },
    },
    lastToolPreview:
      "subagent: build-with-long-description-here - bash: make-build-verbose-compiler-output-here",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  for (const width of [15, 20, 30]) {
    const lines = renderLinesAtWidth(result, width);
    const toolLines = lines.filter((line) => line.includes("→"));
    expect(toolLines.length).toBeLessThanOrEqual(1);
    if (toolLines.length === 1) {
      const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
      expect(visibleText.length).toBeLessThanOrEqual(width);
    }
  }
});
test("running progress preserves sensitive tool name without redaction", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "secret-manager" },
    lastToolPreview: "secret-manager",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 60);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  expect(toolLines[0]).toContain("secret-manager");
  expect(toolLines[0]).not.toContain("(running...)");
  expect(toolLines[0]).not.toContain("(hidden)");
});
test("running progress truncates sensitive tool name within budget", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "secret-manager" },
    lastToolPreview: "secret-manager",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 19);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  expect(stripAnsiAndWrappers(toolLines[0] ?? "").length).toBeLessThanOrEqual(
    19,
  );
  expect(toolLines[0]).toContain("secret");
  expect(toolLines[0]).not.toContain("(hidden)");
});

const fakeTheme: SubagentTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};

describe("renderSubagentProgress", () => {
  test("message without details returns undefined", () => {
    const result = renderSubagentProgress({}, { expanded: false }, fakeTheme);
    expect(result).toBeUndefined();
  });

  test("message with details but no requestId returns undefined", () => {
    const result = renderSubagentProgress(
      { details: {} },
      { expanded: false },
      fakeTheme,
    );
    expect(result).toBeUndefined();
  });

  test("message with empty requestId defers to host default rendering", () => {
    const result = renderSubagentProgress(
      { details: { requestId: "" } },
      { expanded: false },
      fakeTheme,
    );
    expect(result).toBeUndefined();
  });

  test("message with requestId but no progress state returns component rendering zero lines", () => {
    const result = renderSubagentProgress(
      { details: { requestId: "nonexistent-id" } },
      { expanded: false },
      fakeTheme,
    );
    expect(result).toBeDefined();
    expect(result?.render(120)).toEqual([]);
    clearProgressState("nonexistent-id");
  });

  test("message with valid requestId returns component", () => {
    const requestId = `test-render-${Date.now()}`;
    createProgressState(requestId, "test-agent", "user", "test task");
    const result = renderSubagentProgress(
      { details: { requestId } },
      { expanded: false },
      fakeTheme,
    );
    expect(result).toBeDefined();
    clearProgressState(requestId);
  });
});

describe("progress visibility after result posting", () => {
  test("already-created component hides after result posting while retaining state", () => {
    const requestId = "vis-posted-1";
    createProgressState(requestId, "agent", "do work");
    const component = renderSubagentProgress(
      { details: { requestId } },
      { expanded: false },
      fakeTheme,
    );
    expect(component).toBeDefined();
    expect(component?.render(120).length).toBeGreaterThan(0);
    markProgressResultPosted(requestId);
    expect(component?.render(120)).toEqual([]);
    expect(getProgressState(requestId)).toBeDefined();
    clearProgressState(requestId);
  });

  test("component created after result posting renders zero lines", () => {
    const requestId = "vis-post-created";
    createProgressState(requestId, "agent", "do work");
    markProgressResultPosted(requestId);
    const component = renderSubagentProgress(
      { details: { requestId } },
      { expanded: false },
      fakeTheme,
    );
    expect(component).toBeDefined();
    expect(component?.render(120)).toEqual([]);
    expect(getProgressState(requestId)).toBeDefined();
    clearProgressState(requestId);
  });

  test("terminal status alone never hides progress", () => {
    const requestId = "vis-terminal-1";
    createProgressState(requestId, "agent", "do work");
    finalizeProgressState(requestId, "all done");
    const component = renderSubagentProgress(
      { details: { requestId } },
      { expanded: false },
      fakeTheme,
    );
    expect(component?.render(120).length).toBeGreaterThan(0);
    clearProgressState(requestId);
  });

  test("root cancellation without result preserves live card, reload renders no card", () => {
    const requestId = "vis-cancel-1";
    createProgressState(requestId, "agent", "cancel task");
    cancelProgressState(requestId, "user cancelled");
    const live = renderSubagentProgress(
      { details: { requestId } },
      { expanded: false },
      fakeTheme,
    );
    expect(live?.render(120).join("\n")).toContain("cancelled");
    clearProgressState(requestId);
    const replay = renderSubagentProgress(
      { details: { requestId } },
      { expanded: false },
      fakeTheme,
    );
    expect(replay?.render(120)).toEqual([]);
    clearProgressState(requestId);
  });
});

describe("ordinal-aware progress titles", () => {
  test("collapsed progress shows #ordinal only for >=2", () => {
    createProgressState("ord-prog-2", "build", "do work", "brave-otter", 2);
    const rendered2 = renderSubagentProgress(
      {
        customType: "subagent-progress",
        content: "",
        display: true,
        details: { requestId: "ord-prog-2" },
      },
      { expanded: false },
      makeTheme(),
    );
    const text2 = rendered2?.render(80).join("\n") ?? "";
    expect(text2).toContain("#2");
    expect(text2).toContain("brave-otter");
    clearProgressState("ord-prog-2");
    createProgressState("ord-prog-1", "build", "do work", "brave-otter", 1);
    const rendered1 = renderSubagentProgress(
      {
        customType: "subagent-progress",
        content: "",
        display: true,
        details: { requestId: "ord-prog-1" },
      },
      { expanded: false },
      makeTheme(),
    );
    const text1 = rendered1?.render(80).join("\n") ?? "";
    expect(text1).not.toContain("#1");
    expect(text1).toContain("brave-otter");
    clearProgressState("ord-prog-1");
  });
});

describe("live progress accounting integration", () => {
  const liveIds: string[] = [];

  function track(id: string): string {
    liveIds.push(id);
    return id;
  }

  afterEach(() => {
    for (const id of liveIds.splice(0)) clearProgressState(id);
    resetUsageLedger();
  });

  function makeChild(
    id: string,
    agent: string,
    instanceName: string,
    startedAt: number,
    status: UsageInstanceNode["status"] = "running",
    ordinal = 1,
  ): UsageInstanceNode {
    return {
      id,
      agent,
      instanceName,
      ordinal,
      startedAt,
      status,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        turns: 1,
      },
      children: [],
    };
  }

  function setupRootWithChildren(
    requestId: string,
    children: UsageInstanceNode[],
    ordinal?: number,
  ): void {
    resetUsageLedger();
    const res = registerRootInstance({
      id: requestId,
      agent: "build",
      instanceName: "root-run",
      startedAt: 500,
    });
    expect(res.ok).toBe(true);
    for (const child of children) {
      const attach = attachChildSubtree(requestId, child);
      expect(attach.ok).toBe(true);
    }
    createProgressState(
      track(requestId),
      "build",
      "do the important task",
      "root-run",
      ordinal,
    );
  }

  function renderLive(
    requestId: string,
    expanded: boolean,
    width = 120,
  ): string {
    const rendered = renderSubagentProgress(
      {
        customType: "subagent-progress",
        content: "",
        display: true,
        details: { requestId },
      },
      { expanded },
      makeTheme(),
    );
    expect(rendered).toBeDefined();
    return (rendered?.render(width) ?? []).join("\n");
  }

  test("collapsed running adds descendant tally and leaf keeps existing rendering", () => {
    const withKids = track("live-collapsed-1");
    setupRootWithChildren(withKids, [
      makeChild("c-a", "explorer", "able-fox", 1000),
      makeChild("c-b", "worker", "bold-owl", 1100),
    ]);
    patchProgressState(withKids, {
      activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
      lastToolPreview: "bash: ls",
    });
    const text = renderLive(withKids, false);
    expect(text).toContain("2 spawned");
    expect(text).toContain("explorer");
    expect(text).toContain("worker");
    expect(text).toContain("→ bash ls");

    const leaf = track("live-leaf-1");
    resetUsageLedger();
    createProgressState(leaf, "build", "do the important task", "root-run");
    patchProgressState(leaf, {
      activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
      lastToolPreview: "bash: ls",
    });
    const leafText = renderLive(leaf, false);
    expect(leafText).not.toContain("spawned");
    expect(leafText).toContain("→ bash ls");
  });

  test("collapsed running tally omits run cost while retaining glyph-first groups", () => {
    const requestId = track("live-run-cost-1");
    setupRootWithChildren(requestId, [
      makeChild("c-a", "explorer", "able-fox", 1000),
      makeChild("c-b", "worker", "bold-owl", 1100),
    ]);
    patchProgressState(requestId, {
      activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
      lastToolPreview: "bash: ls",
      modelDisplay: "test-model",
    });
    const text = renderLive(requestId, false);
    expect(text).toContain("2 spawned");
    const tallyLine = text.split("\n").find((l) => l.includes("spawned")) ?? "";
    expect(tallyLine).not.toContain("run $");
    expect(tallyLine).toContain("\u27F31");
    expect(text).toContain("test-model");
    expect(text).toContain("→ bash ls");
    expect(text).not.toContain("run $");
  });

  test("expanded running adds bounded tree alongside activity and shows all siblings", () => {
    const requestId = track("live-expanded-1");
    setupRootWithChildren(requestId, [
      makeChild("sib-a", "explorer", "able-fox", 1000),
      makeChild("sib-b", "worker", "bold-owl", 1100),
    ]);
    patchProgressState(requestId, {
      activeToolActivity: {
        toolName: "subagent",
        inputSummary: "subagent: build",
        instanceName: "bold-owl",
        child: { toolName: "bash", inputSummary: "bash: build" },
      },
      lastToolPreview: "subagent: build - bash: build",
    });
    const text = renderLive(requestId, true);
    expect(text).toContain("do the important task");
    expect(text).toContain("able-fox");
    expect(text).toContain("bold-owl");
    expect(text).toContain("⟳");
    const activityOnly = text.split("\n").filter((line) => line.includes("→"));
    expect(activityOnly.join("\n")).not.toContain("able-fox");
    expect(text).toContain("explorer");
    expect(text).toContain("worker");
    expect(text).toContain("spawned");
    expect(text).not.toContain("run $");
  });

  test("rerenders reflect current ledger changes with running counts and omitted totals", () => {
    const requestId = track("live-fresh-1");
    setupRootWithChildren(requestId, [
      makeChild("fresh-a", "explorer", "able-fox", 1000),
    ]);
    const first = renderSubagentProgress(
      {
        customType: "subagent-progress",
        content: "",
        display: true,
        details: { requestId },
      },
      { expanded: false },
      makeTheme(),
    );
    expect(first).toBeDefined();
    expect((first?.render(120) ?? []).join("\n")).toContain("1 spawned");
    const attach = attachChildSubtree(
      requestId,
      makeChild("fresh-b", "worker", "bold-owl", 1100),
    );
    expect(attach.ok).toBe(true);
    expect((first?.render(120) ?? []).join("\n")).toContain("2 spawned");
    const omittedChild = {
      ...makeChild("fresh-c", "reader", "calm-jay", 1200),
      children: [],
      omitted: {
        count: 2,
        totals: {
          instances: 2,
          statuses: { running: 2, success: 0, error: 0, cancelled: 0 },
          usage: {
            input: 4,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.004,
            turns: 2,
          },
          durationMs: 0,
          byAgent: {
            helper: {
              instances: 2,
              statuses: { running: 2, success: 0, error: 0, cancelled: 0 },
              usage: {
                input: 4,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.004,
                turns: 2,
              },
              durationMs: 0,
            },
          },
        },
      },
    } as UsageInstanceNode;
    expect(attachChildSubtree(requestId, omittedChild).ok).toBe(true);
    const withOmitted = (first?.render(120) ?? []).join("\n");
    expect(withOmitted).toContain("helper");
    expect(queryInstanceUsage(requestId)?.rollup.instances).toBe(6);
  });

  test("title and tree nodes omit ordinal 1 and tally uses full query", () => {
    const requestId = track("live-ordinal-1");
    setupRootWithChildren(
      requestId,
      [makeChild("ord-child", "explorer", "able-fox", 1000, "running", 1)],
      1,
    );
    const collapsed = renderLive(requestId, false);
    expect(collapsed).not.toContain("#1");
    expect(collapsed).toContain("spawned");
    const expanded = renderLive(requestId, true);
    expect(expanded).not.toContain("#1");
    expect(expanded).toContain("explorer able-fox");
    const full = queryInstanceUsage(requestId)?.instance;
    expect(full).toBeDefined();
    if (full) {
      expect(formatDescendantTally(full, 114)).toBeDefined();
      expect(collapsed).toContain(
        (formatDescendantTally(full, 114) ?? "").split(" · ")[0] ?? "spawned",
      );
    }
  });

  test("oversized live query bounds tree to 50 nodes while tally keeps full count", () => {
    const requestId = track("live-oversized-1");
    const children: UsageInstanceNode[] = [];
    for (let i = 0; i < 60; i += 1) {
      children.push(
        makeChild(`over-${i}`, `agent-${i % 5}`, `instance-${i}`, 1000 + i),
      );
    }
    setupRootWithChildren(requestId, children);
    const collapsed = renderLive(requestId, false, 200);
    expect(collapsed).toContain("60 spawned");
    const expanded = renderLive(requestId, true, 200);
    expect(expanded).toContain("earlier");
    const treeLines = expanded
      .split("\n")
      .filter((line) => line.includes("agent-"));
    expect(treeLines.length).toBeLessThan(60);
    expect(queryInstanceUsage(requestId)?.rollup.instances).toBe(61);
  });

  test("terminal cards keep styling with tally and tree and narrow width suppresses tally", () => {
    const requestId = track("live-terminal-1");
    setupRootWithChildren(requestId, [
      makeChild("term-a", "explorer", "able-fox", 1000),
    ]);
    finalizeProgressState(requestId, "all done");
    const collapsed = renderLive(requestId, false);
    expect(collapsed).toContain("all done");
    expect(collapsed).toContain("spawned");
    expect(collapsed).not.toContain("run $");
    const expanded = renderLive(requestId, true);
    expect(expanded).toContain("do the important task");
    expect(expanded).toContain("able-fox");
    expect(expanded).toContain("all done");
    expect(expanded).toContain("spawned");
    expect(expanded).not.toContain("run $");
    const narrow = renderLive(requestId, false, 20);
    expect(narrow).not.toContain("spawned");
    expect(narrow).toContain("all done");
  });

  test("missing ledger entry falls back to existing rendering without throw", () => {
    const requestId = track("live-missing-1");
    resetUsageLedger();
    createProgressState(
      requestId,
      "build",
      "do the important task",
      "root-run",
    );
    patchProgressState(requestId, {
      activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
      lastToolPreview: "bash: ls",
    });
    const collapsed = renderLive(requestId, false);
    expect(collapsed).toContain("→ bash ls");
    expect(collapsed).not.toContain("spawned");
    const expanded = renderLive(requestId, true);
    expect(expanded).toContain("do the important task");
    expect(expanded).not.toContain("spawned");
  });

  test("collapsed success without output renders tally without output line", () => {
    const requestId = track("live-no-output-collapsed");
    setupRootWithChildren(requestId, [
      makeChild("noc-a", "explorer", "able-fox", 1000),
    ]);
    finalizeProgressState(requestId, "done");
    patchProgressState(requestId, { finalOutput: "" });
    const text = renderLive(requestId, false);
    const contentLines = text
      .split("\n")
      .filter(
        (line) => !/^\[toolSuccessBg\]\s*\[\/toolSuccessBg\]$/.test(line),
      );
    expect(contentLines).toHaveLength(2);
    expect(contentLines[1]).toContain("1 spawned");
    expect(text).not.toContain("done");
    expect(text).not.toContain("─── Output ───");
  });

  test("expanded success without output omits body but shows task with tree and tally", () => {
    const requestId = track("live-no-output-expanded");
    setupRootWithChildren(requestId, [
      makeChild("noe-a", "explorer", "able-fox", 1000),
    ]);
    finalizeProgressState(requestId, "done");
    patchProgressState(requestId, { finalOutput: "" });
    const text = renderLive(requestId, true);
    expect(text).not.toContain("(no output)");
    expect(text).toContain("task: do the important task");
    expect(text).toContain("able-fox");
    expect(text).toContain("1 spawned");
    expect(text).not.toContain("done");
    expect(text).not.toContain("─── Output ───");
  });
  test.each([
    {
      state: "error",
      settle: (requestId: string) =>
        failProgressState(requestId, "child exploded"),
      stoppedText: "child exploded",
    },
    {
      state: "cancelled",
      settle: (requestId: string) =>
        cancelProgressState(requestId, "user cancelled"),
      stoppedText: "user cancelled",
    },
  ])(
    "collapsed $state keeps stopped text with descendant tally",
    ({ settle, stoppedText }) => {
      const requestId = track(`live-collapsed-stopped-${stoppedText}`);
      setupRootWithChildren(requestId, [
        makeChild("stop-a", "explorer", "able-fox", 1000),
      ]);
      settle(requestId);
      const text = renderLive(requestId, false);
      expect(text).toContain(stoppedText);
      expect(text).toContain("1 spawned");
      expect(text).toContain("explorer");
    },
  );

  test.each([
    {
      state: "error",
      settle: (requestId: string) =>
        failProgressState(requestId, "child exploded"),
      stoppedText: "child exploded",
    },
    {
      state: "cancelled",
      settle: (requestId: string) =>
        cancelProgressState(requestId, "user cancelled"),
      stoppedText: "user cancelled",
    },
  ])(
    "expanded $state adds bounded tree lines after stopped text",
    ({ settle, stoppedText }) => {
      const requestId = track(`live-expanded-stopped-${stoppedText}`);
      setupRootWithChildren(requestId, [
        makeChild("stop-b", "explorer", "able-fox", 1000),
      ]);
      settle(requestId);
      const text = renderLive(requestId, true);
      expect(text).toContain(stoppedText);
      expect(text).toContain("do the important task");
      expect(text).toContain("\u27f3 explorer able-fox");
    },
  );
});

test("progress cards use semantic role hierarchy", () => {
  const requestId = "theme-roles-progress";
  resetUsageLedger();
  const res = registerRootInstance({
    id: requestId,
    agent: "build",
    instanceName: "root-run",
    startedAt: 500,
  });
  expect(res.ok).toBe(true);
  expect(
    attachChildSubtree(requestId, {
      id: "child-1",
      agent: "worker",
      instanceName: "child-one",
      ordinal: 1,
      startedAt: 600,
      status: "success",
      durationMs: 100,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        turns: 1,
      },
      children: [],
    }).ok,
  ).toBe(true);
  createProgressState(requestId, "build", "do task", "root-run");
  patchProgressState(requestId, {
    toolCount: 1,
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls -la" },
    lastToolPreview: "bash: ls -la",
    modelDisplay: "provider/model:high",
  });
  const theme = makeMarkerTheme();
  const rendered = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId },
    },
    { expanded: true },
    theme,
  );
  const text = renderText(rendered);
  expect(text).toContain("<muted>[running]</muted>");
  expect(text).toContain("<muted>task:</muted>");
  expect(text).toContain("<muted><italic>do task</italic></muted>");
  expect(text).toContain("<dim>→</dim>");
  expect(text).toContain("<text>bash</text>");
  expect(text).toContain("<dim> ls -la</dim>");
  expect(text).toContain("<dim>provider/model:high</dim>");
  expect(text).toContain("<dim>1 tool");
  expect(text).toContain("spawned");
  expect(text).toContain("<muted>");
  expect(text).toContain("<dim>");
  expect(text).not.toContain("<muted>task: do task</muted>");
  expect(text).not.toContain("<muted>→</muted>");
  expect(text).not.toContain("<muted>provider/model:high</muted>");
  clearProgressState(requestId);
  resetUsageLedger();
});

describe("T-002 innermost activity and tool-free thinking", () => {
  test("shows root tool without identity using space grammar", () => {
    const text = renderActivityCard("t002-root", {
      toolName: "bash",
      inputSummary: "bash: ls",
    }).join("\n");
    expect(text).toContain("<dim>→</dim> <text>bash</text><dim> ls</dim>");
    expect(text).not.toContain("›");
  });

  test("shows direct child identity without ellipsis", () => {
    const text = renderActivityCard("t002-direct", {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: { toolName: "bash", inputSummary: "bash: make" },
    }).join("\n");
    expect(text).toContain("build");
    expect(text).toContain("swift-harbor");
    expect(text).toContain("<text>bash</text>");
    expect(text).not.toContain("<dim>…</dim>");
  });

  test("shows only innermost with ellipsis below direct child", () => {
    const text = renderActivityCard("t002-nested", {
      toolName: "subagent",
      inputSummary: "subagent: outer",
      instanceName: "outer-inst",
      child: {
        toolName: "subagent",
        inputSummary: "subagent: inner",
        instanceName: "inner-inst",
        child: { toolName: "bash", inputSummary: "bash: test" },
      },
    }).join("\n");
    expect(text).toContain("<dim>…</dim>");
    expect(text).toContain("inner");
    expect(text).toContain("inner-inst");
    expect(text).not.toContain("outer-inst");
  });

  test("renders unnamed delegation as tool subagent without identity", () => {
    const text = renderActivityCard("t002-unnamed", {
      toolName: "subagent",
      inputSummary: "subagent",
    }).join("\n");
    expect(text).toContain("<text>subagent</text>");
    expect(text).not.toContain("thinking");
  });

  test("splits flattened tool text only at first colon space", () => {
    const text = renderActivityCard("t002-flat", {
      toolName: "tool",
      inputSummary: "bash: ls: verbose",
    }).join("\n");
    expect(text).toContain("<text>bash</text><dim> ls: verbose</dim>");
  });

  test("replaces only sensitive target and preserves agent and tool names", () => {
    const text = renderActivityCard("t002-sensitive", {
      toolName: "subagent",
      inputSummary: "subagent: secret-agent",
      instanceName: "token-instance",
      child: { toolName: "token", inputSummary: "token: secret-value" },
    }).join("\n");
    expect(text).toContain("secret-agent");
    expect(text).toContain("token-instance");
    expect(text).toContain("<text>token</text>");
    expect(text).toContain("<italic>(hidden)</italic>");
    expect(text).not.toContain("secret-value");
  });

  test("renders stored placeholder as hidden through budget", () => {
    const text = renderActivityCard("t002-placeholder", {
      toolName: "bash",
      inputSummary: "(running...)",
    }).join("\n");
    expect(text).toContain("<italic>(hidden)</italic>");
    expect(text).not.toContain("(running...)");
  });

  test("renders root tool-free interval as thinking", () => {
    const text = renderActivityCard("t002-thinking-root").join("\n");
    expect(text).toContain("<italic>thinking</italic>");
    expect(text).toContain("<dim>→</dim>");
  });

  test("renders delegate without tool as identity thinking with roles", () => {
    const text = renderActivityCard("t002-thinking-delegate", {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      ordinal: 2,
    }).join("\n");
    expect(text).toContain("<toolTitle>build</toolTitle>");
    expect(text).toContain("<dim>#2</dim>");
    expect(text).toContain("<accent><italic>swift-harbor</italic></accent>");
    expect(text).toContain("<italic>thinking</italic>");
    expect(text).toContain("<dim>›</dim>");
  });

  test("keeps sanitized bare tool name target-free without hidden", () => {
    const text = renderActivityCard("t002-bare", {
      toolName: "bash",
      inputSummary: "bash",
    }).join("\n");
    expect(text).toContain("<text>bash</text>");
    expect(text).not.toContain("(hidden)");
  });

  test("keeps root tool and target roles when the target contains a separator", () => {
    const line = findActivityRow(
      renderActivityCard("t002-separator", {
        toolName: "bash",
        inputSummary: "bash: echo a › b",
      }),
    );
    expect(line).toContain("<text>bash</text><dim> echo a › b</dim>");
    expect(line).not.toContain("<toolTitle>");
    expect(line).not.toContain("<accent>");
  });

  test("keeps a tool named thinking in the tool role", () => {
    const line = findActivityRow(
      renderActivityCard("t002-thinking-tool", {
        toolName: "thinking",
        inputSummary: "thinking",
      }),
    );
    expect(line).toContain("<text>thinking</text>");
    expect(line).not.toContain("<italic>");
  });

  test("keeps a literal hidden target in the target role", () => {
    const line = findActivityRow(
      renderActivityCard("t002-literal-hidden", {
        toolName: "bash",
        inputSummary: "bash: (hidden)",
      }),
    );
    expect(line).toContain("<text>bash</text><dim> (hidden)</dim>");
    expect(line).not.toContain("<italic>");
  });

  test("emphasizes activity tool name with fg and bold", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => `<bold>${text}</bold>`,
      italic: (text: string) => `<italic>${text}</italic>`,
      underline: (text: string) => `<underline>${text}</underline>`,
      strikethrough: (text: string) => `<strike>${text}</strike>`,
    };
    const line = findActivityRow(
      renderActivityCard(
        "t001-emphasis",
        { toolName: "bash", inputSummary: "bash: ls" },
        { theme },
      ),
    );
    expect(line).toContain("<text><bold>bash</bold></text><dim> ls</dim>");
    expect(line).not.toContain("<toolTitle>");
    expect(line).not.toContain("<accent>");
    const bareLine = findActivityRow(
      renderActivityCard(
        "t001-emphasis-bare",
        { toolName: "bash", inputSummary: "bash" },
        { theme },
      ),
    );
    expect(bareLine).toContain("<text><bold>bash</bold></text>");
    expect(bareLine).not.toContain("<dim> ");
  });
});

describe("T-003 Protect, shorten, and bound activity targets", () => {
  test("shortens cwd-relative path in card within width", () => {
    const originalCwd = process.cwd;
    const originalHome = process.env["HOME"];
    (process as unknown as { cwd: () => string }).cwd = () => "/repo";
    process.env["HOME"] = "/home/user";
    try {
      const toolLine = findActivityRow(
        renderActivityCard(
          "t003-card-path",
          { toolName: "bash", inputSummary: "bash: /repo/src/file.ts" },
          { theme: makeTheme(), width: 80 },
        ),
      );
      expect(toolLine).toContain("src/file.ts");
      expect(toolLine).not.toContain("/repo/src/file.ts");
      expect(stripAnsiAndWrappers(toolLine).length).toBeLessThanOrEqual(80);
    } finally {
      (process as unknown as { cwd: () => string }).cwd = originalCwd;
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
    }
  });

  test("bounds hidden and long activity within narrow card width", () => {
    for (const width of [20, 30, 60]) {
      const lines = renderActivityCard(
        "t003-card-bounds",
        {
          toolName: "bash",
          inputSummary: "bash: secret-value-with-long-suffix-that-exceeds",
        },
        { theme: makeTheme(), width },
      );
      for (const line of lines) {
        expect(stripAnsiAndWrappers(line).length).toBeLessThanOrEqual(width);
      }
      expect(findActivityRow(lines)).not.toContain("secret");
    }
  });

  test("renders tool-free activity as truncated thinking row at narrow width", () => {
    const toolLine = stripAnsiAndWrappers(
      findActivityRow(
        renderActivityCard("t003-card-thinking", undefined, {
          theme: makeTheme(),
          width: 12,
        }),
      ),
    );
    expect(toolLine).toContain("thi…");
    expect(toolLine.length).toBeLessThanOrEqual(12);
  });

  test("renders hidden activity as truncated row at narrow width", () => {
    const toolLine = stripAnsiAndWrappers(
      findActivityRow(
        renderActivityCard(
          "t003-card-hidden",
          { toolName: "tool", inputSummary: "(running...)" },
          { theme: makeTheme(), width: 12 },
        ),
      ),
    );
    expect(toolLine).toContain("(hi…");
    expect(toolLine.length).toBeLessThanOrEqual(12);
    expect(toolLine).not.toContain("(running...)");
  });

  test("preserves card padding and indentation", () => {
    const toolLine =
      renderActivityCard("t003-card-indent", {
        toolName: "bash",
        inputSummary: "bash: ls",
      }).find((line) => line.includes("bash")) ?? "";
    expect(toolLine.startsWith("[toolPendingBg]   <dim>→</dim>")).toBe(true);
  });
});
