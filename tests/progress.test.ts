import { afterEach, describe, expect, test } from "bun:test";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { SubagentTheme } from "../src/output/ui.js";
import {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  makeToolPreview,
  patchProgressState,
  renderSubagentProgress,
} from "../src/progress/progress.js";

const realDateNow = Date.now;

function setDateNow(now: number): void {
  Date.now = () => now;
}

afterEach(() => {
  Date.now = realDateNow;
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
  };
}

function makeMarkerTheme() {
  return {
    fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => text,
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

test("renderSubagentProgress returns undefined for missing state", () => {
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "no-such-id" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeUndefined();
});

test("renderSubagentProgress formats segmented agent and instance title", () => {
  createProgressState("rend-1", "my-agent", "do the thing", "able-falcon");
  const theme = {
    fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => `<bold>${text}</bold>`,
    italic: (text: string) => `<italic>${text}</italic>`,
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
  expect(text).toContain("<dim>[running]</dim>");
  expect(text).toContain("<muted>0 tools · --% ctx ·");
});

test("renderSubagentProgress uses ANSI italic fallback for instance title", () => {
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
  expect(text).toContain(
    "<toolTitle>my-agent</toolTitle> <accent>\x1b[3mable-falcon\x1b[23m</accent> <dim>[running]</dim>",
  );
  expect(text.indexOf("\x1b[23m</accent> <dim>[running]")).toBeGreaterThan(-1);
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
    "<toolTitle>my-agent</toolTitle> <dim>[running]</dim>",
  );
  expect(firstText).not.toContain("my-agent  ");
  expect(firstText).not.toContain("\x1b[3m");
  expect(secondText).toContain(
    "<toolTitle>other-agent</toolTitle> <dim>[running]</dim>",
  );
  expect(secondText).not.toContain("other-agent  ");
  expect(secondText).not.toContain("\x1b[3m");
});

test("renderSubagentProgress collapsed running colors tool preview segments", () => {
  setDateNow(1000);
  createProgressState("rend-1", "my-agent", "do the thing", "rend-1");
  setDateNow(3500);
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
    "my-agent</toolTitle> <accent>\x1b[3mrend-1\x1b[23m</accent>",
  );
  expect(text).toContain("running");
  expect(text).toContain("3 tools · 8%");
  expect(text.indexOf("\x1b[23m</accent> <dim>[running]")).toBeLessThan(
    text.indexOf("3 tools · 8%"),
  );
  expect(text).toContain("ctx · 2.5s");
  expect(text).not.toContain("1.2k in");
  expect(text).not.toContain("300 out");
  expect(text).not.toContain("1.2k in · 300 out · 8% ctx");
  expect(text).not.toContain("2 turns");
  expect(text).not.toContain("18k ctx");
  expect(toolLine).toStartWith(
    "[toolPendingBg]   <muted>→</muted> <accent>bash</accent><dim>: ls -la</dim>",
  );
  expect(text).not.toContain("bash: ls -la (");
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
    "[toolPendingBg]   <muted>→</muted> <accent>bash</accent>",
  );
  expect(toolLine).not.toContain("<dim>:");
  expect(toolLine).not.toContain("</accent>:");
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
    "[toolPendingBg]   <muted>→</muted> <accent>unknown_tool</accent>",
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
  expect(text).toContain("→ bash:");
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
  expect(text).toContain("→ bash: pwd");
  expect(text).not.toContain("bash: pwd (");
});

test("renderSubagentProgress renders modelDisplay footer if present", () => {
  createProgressState("rend-model", "model-agent", "model task");
  patchProgressState("rend-model", { modelDisplay: "gemini-1.5-pro" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-model" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("gemini-1.5-pro");
});

test("renderSubagentProgress renders modelDisplay footer for expanded running state", () => {
  createProgressState("rend-model-exp", "model-agent", "model task");
  patchProgressState("rend-model-exp", {
    modelDisplay: "gemini-1.5-pro",
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-model-exp" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("gemini-1.5-pro");
  expect(text).toContain("model task");
  expect(text).toContain("bash: ls");
});

test("renderSubagentProgress renders modelDisplay footer for error state", () => {
  createProgressState("rend-err", "err-agent", "error task");
  failProgressState("rend-err", "something exploded");
  patchProgressState("rend-err", { modelDisplay: "claude-3-5-sonnet" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-err" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("claude-3-5-sonnet");
  expect(text).toContain("something exploded");
});

test("renderSubagentProgress renders modelDisplay footer for expanded error state", () => {
  createProgressState("rend-err-exp", "err-agent", "error task");
  failProgressState("rend-err-exp", "something exploded");
  patchProgressState("rend-err-exp", { modelDisplay: "claude-3-5-sonnet" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-err-exp" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("claude-3-5-sonnet");
  expect(text).toContain("something exploded");
  expect(text).toContain("error task");
});

test("renderSubagentProgress renders modelDisplay footer for cancelled state", () => {
  createProgressState("rend-cancel", "cancel-agent", "cancel task");
  cancelProgressState("rend-cancel", "user cancelled");
  patchProgressState("rend-cancel", { modelDisplay: "gpt-4o" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-cancel" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("gpt-4o");
  expect(text).toContain("cancelled");
});

test("renderSubagentProgress renders modelDisplay footer for expanded cancelled state", () => {
  createProgressState("rend-cancel-exp", "cancel-agent", "cancel task");
  cancelProgressState("rend-cancel-exp", "user cancelled");
  patchProgressState("rend-cancel-exp", { modelDisplay: "gpt-4o" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-cancel-exp" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("gpt-4o");
  expect(text).toContain("cancel task");
});

test("renderSubagentProgress renders modelDisplay footer for success state", () => {
  createProgressState("rend-ok", "ok-agent", "success task");
  finalizeProgressState("rend-ok", "all done");
  patchProgressState("rend-ok", { modelDisplay: "provider/model:compact" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-ok" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("provider/model:compact");
  expect(text).toContain("all done");
});

test("renderSubagentProgress renders modelDisplay footer for expanded success state", () => {
  createProgressState("rend-ok-exp", "ok-agent", "success task");
  finalizeProgressState("rend-ok-exp", "all done");
  patchProgressState("rend-ok-exp", { modelDisplay: "provider/model:compact" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-ok-exp" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("provider/model:compact");
  expect(text).toContain("success task");
  expect(text).toContain("all done");
});

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
  expect(text).toContain("err-agent \x1b[3mrend-3\x1b[23m");
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
  expect(text.indexOf("\x1b[23m</accent> <dim>[success]")).toBeLessThan(
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
  expect(text).toContain("some-agent \x1b[3mrend-5\x1b[23m");
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
  setDateNow(1000);
  createProgressState("rend-7", "ok-agent", "a task");
  setDateNow(2500);
  finalizeProgressState("rend-7", "final result text");
  setDateNow(9000);
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
  setDateNow(1000);
  createProgressState("rend-8", "err-agent", "error task");
  setDateNow(4000);
  failProgressState("rend-8", "child failed");
  setDateNow(10_000);
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
  setDateNow(2000);
  createProgressState("rend-9", "cancel-agent", "cancel task");
  setDateNow(6500);
  cancelProgressState("rend-9", "user cancelled");
  setDateNow(12_000);
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

test("renderSubagentProgress keeps running elapsed live", () => {
  setDateNow(1000);
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
  setDateNow(2500);
  expect(renderText(result)).toContain("1.5s");
  setDateNow(5200);
  expect(renderText(result)).toContain("4.2s");
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
  expect(toolLines[0]).toContain("subagent");
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
    "[toolPendingBg]   <muted>→</muted> <accent>bash</accent>",
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
  expect(text).toContain("→ bash: ls");
  const lines = renderLines(result);
  const taskLineIndex = lines.findIndex((line) =>
    line.includes("do the important task"),
  );
  const toolLineIndex = lines.findIndex((line) => line.includes("→ bash: ls"));
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
  expect(text).toContain("<dim>[running]</dim>");
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
test("running progress redacts sensitive toolName fallback at sufficient budget", () => {
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
  expect(toolLines[0]).toContain("(running...)");
  expect(toolLines[0]).not.toContain("secret-manager");
});
test("running progress omits sensitive toolName fallback when budget too small for redaction", () => {
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
  expect(toolLines.length).toBe(0);
});

const fakeTheme: SubagentTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

describe("progress.ts uncovered branches", () => {
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

    test("message with requestId but no progress state returns undefined", () => {
      const result = renderSubagentProgress(
        { details: { requestId: "nonexistent-id" } },
        { expanded: false },
        fakeTheme,
      );
      expect(result).toBeUndefined();
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
});
