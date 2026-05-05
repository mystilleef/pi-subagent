import { afterEach, expect, test } from "bun:test";
import type { Message } from "@mariozechner/pi-ai";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  formatCost,
  formatElapsed,
  formatHeaderStats,
  formatTokenCount,
  getProgressState,
  makeTaskPreview,
  makeToolPreview,
  patchProgressState,
  renderSubagentProgress,
} from "../src/progress.js";
import type { SubagentDetails } from "../src/types.js";

function makeDetails(
  messages: { role: string; content: unknown[] }[],
): SubagentDetails {
  return {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "test-agent",
        agentSource: "user",
        task: "test task",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        messages: messages as unknown as Message[],
      },
    ],
  };
}

afterEach(() => {
  clearProgressState("req-1");
  clearProgressState("req-2");
  for (let i = 1; i <= 9; i++) clearProgressState(`rend-${i}`);
});

test("createProgressState initializes defaults", () => {
  const before = Date.now();
  createProgressState("req-1", "my-agent", "do the thing");
  const state = getProgressState("req-1");
  expect(state).toBeDefined();
  expect(state?.requestId).toBe("req-1");
  expect(state?.agent).toBe("my-agent");
  expect(state?.taskPreview).toBe("do the thing");
  expect(state?.status).toBe("running");
  expect(state?.startTime).toBeGreaterThanOrEqual(before);
  expect(state?.toolCount).toBe(0);
  expect(state?.lastToolName).toBeUndefined();
  expect(state?.lastToolPreview).toBeUndefined();
  expect(state?.finalOutput).toBeUndefined();
  expect(state?.errorText).toBeUndefined();
});

test("getProgressState returns undefined for unknown request id", () => {
  expect(getProgressState("nonexistent")).toBeUndefined();
});

test("patchProgressState merges fields without replacing unpatched fields", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { toolCount: 3, lastToolName: "bash" });
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(3);
  expect(state?.lastToolName).toBe("bash");
  expect(state?.agent).toBe("agent-a");
  expect(state?.status).toBe("running");
});

test("finalizeProgressState sets success status and final output", () => {
  createProgressState("req-1", "agent-a", "task a");
  finalizeProgressState("req-1", "all done");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("success");
  expect(state?.finalOutput).toBe("all done");
  expect(state?.errorText).toBeUndefined();
});

test("terminal helpers clear transient tool fields and keep semantic text", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolName: "bash",
    lastToolPreview: "bash: noisy command",
  });
  const longOutcome = "x".repeat(600);
  finalizeProgressState(
    "req-1",
    `Outcome: ${longOutcome}\nChanged: src/progress.ts`,
  );
  const successState = getProgressState("req-1");
  expect(successState?.lastToolName).toBeUndefined();
  expect(successState?.lastToolPreview).toBeUndefined();
  expect(successState?.finalOutput).toContain(longOutcome);
  expect(successState?.finalOutput).not.toContain("...");
  createProgressState("req-2", "agent-b", "task b");
  patchProgressState("req-2", {
    lastToolName: "read",
    lastToolPreview: "read: /tmp/file",
  });
  const longCause = "e".repeat(600);
  failProgressState("req-2", `Cause: ${longCause}`);
  const errorState = getProgressState("req-2");
  expect(errorState?.lastToolName).toBeUndefined();
  expect(errorState?.lastToolPreview).toBeUndefined();
  expect(errorState?.errorText).toBe(longCause);
  expect(errorState?.errorText).not.toContain("...");
});

test("progress error keeps long labeled semantic cause and outcome", () => {
  createProgressState("req-1", "agent-a", "task a");
  const longCause = `database migration failed ${"x".repeat(600)}`;
  failProgressState("req-1", `Outcome: failed\nCause: ${longCause}`);
  expect(getProgressState("req-1")?.errorText).toBe(longCause);
  createProgressState("req-2", "agent-b", "task b");
  const longOutcome = `dependency install blocked ${"y".repeat(600)}`;
  failProgressState("req-2", `Outcome: ${longOutcome}`);
  expect(getProgressState("req-2")?.errorText).toBe(longOutcome);
});

test("progress error omits long unstructured blobs", () => {
  createProgressState("req-1", "agent-a", "task a");
  const blob = Array.from(
    { length: 60 },
    (_, index) => `at Object.fn (/tmp/noisy-${index}.js:1:1)`,
  ).join("\n");
  failProgressState("req-1", blob);
  const state = getProgressState("req-1");
  expect(state?.errorText).toBe("Large unstructured error output omitted.");
  expect(state?.errorText).not.toContain("noisy-1");
});

test("progress error chooses status error check then semantic line", () => {
  createProgressState("req-1", "agent-a", "task a");
  failProgressState(
    "req-1",
    "debug: noisy\nCheck: bun test failed\nmeaningful fallback line",
  );
  expect(getProgressState("req-1")?.errorText).toBe("Check: bun test failed");
  createProgressState("req-2", "agent-b", "task b");
  failProgressState("req-2", "debug: noisy\nmeaningful fallback line");
  expect(getProgressState("req-2")?.errorText).toBe("meaningful fallback line");
});

test("failProgressState sets error status and error text", () => {
  createProgressState("req-1", "agent-a", "task a");
  failProgressState("req-1", "something exploded");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("error");
  expect(state?.errorText).toBe("something exploded");
  expect(state?.finalOutput).toBeUndefined();
});

test("cancelProgressState sets cancelled status", () => {
  createProgressState("req-1", "agent-a", "task a");
  cancelProgressState("req-1", "user aborted");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBe("user aborted");
});

test("cancelProgressState with no reason leaves errorText undefined", () => {
  createProgressState("req-1", "agent-a", "task a");
  cancelProgressState("req-1");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBeUndefined();
});

test("clearProgressState removes state", () => {
  createProgressState("req-1", "agent-a", "task a");
  clearProgressState("req-1");
  expect(getProgressState("req-1")).toBeUndefined();
});

test("clearProgressState is a no-op for unknown id", () => {
  expect(() => clearProgressState("nonexistent")).not.toThrow();
});

test("makeTaskPreview returns full text when within bound", () => {
  expect(makeTaskPreview("short task")).toBe("short task");
});

test("makeTaskPreview labels empty task as agent default", () => {
  expect(makeTaskPreview("")).toBe("(agent default)");
});

test("makeTaskPreview keeps long semantic task text", () => {
  const long = "a".repeat(100);
  const preview = makeTaskPreview(long);
  expect(preview).toBe(long);
  expect(preview).not.toContain("...");
});

test("makeTaskPreview collapses whitespace", () => {
  expect(makeTaskPreview("line one\nline two")).toBe("line one line two");
});

test("makeToolPreview formats tool name and first arg value", () => {
  const preview = makeToolPreview("bash", { command: "ls -la" });
  expect(preview).toBe("bash: ls -la");
});

test("makeToolPreview keeps semantic target without ellipsis", () => {
  const path = "a".repeat(100);
  const preview = makeToolPreview("read", { path });
  expect(preview).toBe(`read: ${path}`);
  expect(preview).not.toContain("...");
});

test("makeToolPreview handles empty args", () => {
  expect(makeToolPreview("bash", {})).toBe("bash");
  expect(makeToolPreview("bash", undefined)).toBe("bash");
});

test("multiple independent request ids are isolated", () => {
  createProgressState("req-1", "agent-a", "task a");
  createProgressState("req-2", "agent-b", "task b");
  finalizeProgressState("req-1", "output a");
  const s1 = getProgressState("req-1");
  const s2 = getProgressState("req-2");
  expect(s1?.status).toBe("success");
  expect(s2?.status).toBe("running");
  expect(s2?.agent).toBe("agent-b");
});

test("extractProgressFromDetails returns empty result for details with no messages", () => {
  const details = makeDetails([]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolName).toBeUndefined();
  expect(result.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails returns new tool call ids from assistant messages", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "tc-2",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toContain("tc-1");
  expect(result.newToolCallIds).toContain("tc-2");
  expect(result.newToolCallIds.length).toBe(2);
});

test("extractProgressFromDetails skips already-seen tool call ids", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "tc-2",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    },
  ]);
  const seen = new Set(["tc-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-2"]);
});

test("extractProgressFromDetails mutates seen ids and reports count delta", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
        { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
        { type: "toolCall", id: "tc-2", name: "read", arguments: {} },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-1", "tc-2"]);
  expect([...seen].sort()).toEqual(["tc-1", "tc-2"]);
});

test("extractProgressFromDetails handles malformed and nested message data safely", () => {
  const details = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      { messages: null },
      { messages: [{ role: "assistant", content: null }] },
      {
        messages: [
          {
            role: "assistant",
            content: [
              null,
              { type: "toolCall", id: 42, name: "bad" },
              {
                type: "toolCall",
                id: "tc-nested",
                name: "outer",
                arguments: { nested: { path: "/tmp/x" } },
              },
            ],
          },
        ],
      },
    ],
  } as unknown as SubagentDetails;
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-nested"]);
  expect(result.lastToolName).toBe("outer");
  expect(result.lastToolPreview).toBe('outer: {"nested":{"path":"/tmp/x"}}');
});

test("extractProgressFromDetails returns last tool name and preview", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "tc-2",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolName).toBe("read");
  expect(result.lastToolPreview).toBe("read: /tmp/foo");
});

test("extractProgressFromDetails ignores non-assistant messages", () => {
  const details = makeDetails([
    { role: "user", content: [{ type: "text", text: "do something" }] },
    {
      role: "toolResult",
      content: [
        {
          type: "toolResultContent",
          toolCallId: "tc-x",
          content: [{ type: "text", text: "done" }],
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolName).toBeUndefined();
});

test("extractProgressFromDetails handles empty output when no results", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolName).toBeUndefined();
});

function makeTheme() {
  return {
    fg: (_color: ThemeColor, text: string) => text,
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

function renderText(
  rendered: { render(width: number): string[] } | undefined,
): string {
  return renderLines(rendered).join("\n");
}

test("formatElapsed renders seconds for short durations", () => {
  expect(formatElapsed(2500)).toBe("2.5s");
});

test("formatElapsed renders minutes and seconds for long durations", () => {
  expect(formatElapsed(90000)).toBe("1m 30s");
});

test("formatElapsed renders 0s for zero", () => {
  expect(formatElapsed(0)).toBe("0.0s");
});

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

test("renderSubagentProgress collapsed running shows agent, status, tool count, tool preview", () => {
  createProgressState("rend-1", "my-agent", "do the thing");
  patchProgressState("rend-1", {
    toolCount: 3,
    lastToolPreview: "bash: ls",
    turns: 2,
    contextTokens: 18_000,
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
  expect(text).toContain("my-agent");
  expect(text).toContain("running");
  expect(text).toContain("3 tools");
  expect(text).toContain("2 turns");
  expect(text).toContain("18k ctx");
  expect(text).toContain("→ bash: ls");
  expect(text).not.toContain("bash: ls (");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolPendingBg]") && line.endsWith("[/toolPendingBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress expanded running includes task preview", () => {
  createProgressState("rend-2", "my-agent", "do the thing");
  patchProgressState("rend-2", {
    toolCount: 1,
    lastToolPreview: "read: /tmp/x",
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
  expect(text).toContain("do the thing");
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
  expect(renderText(result)).toContain("0 tools");
  patchProgressState("rend-live", {
    toolCount: 2,
    lastToolPreview: "bash: pwd",
    turns: 3,
    contextTokens: 10_000,
    inputTokens: 1200,
    outputTokens: 300,
  });
  const text = renderText(result);
  expect(text).toContain("2 tools");
  expect(text).toContain("3 turns");
  expect(text).toContain("10k ctx");
  expect(text).toContain("1.2k in / 300 out");
  expect(text).toContain("→ bash: pwd");
  expect(text).not.toContain("bash: pwd (");
});

test("format header stats compacts usage fields", () => {
  expect(formatTokenCount(12345)).toBe("12.3k");
  expect(formatCost(0.034)).toBe("$0.03");
  expect(
    formatHeaderStats({
      requestId: "req-1",
      agent: "agent-a",
      taskPreview: "task a",
      status: "running",
      startTime: 0,
      toolCount: 3,
      turns: 2,
      contextTokens: 18_000,
      inputTokens: 7100,
      outputTokens: 890,
      cacheReadTokens: 1000,
      cacheWriteTokens: 400,
      cost: 0.034,
    }),
  ).toBe(
    "3 tools · 2 turns · 18k ctx · 7.1k in / 890 out · 1.4k cache · $0.03",
  );
});

test("renderSubagentProgress error state shows error text", () => {
  createProgressState("rend-3", "err-agent", "a task");
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
  expect(text).toContain("error");
  expect(text).toContain("something exploded");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress final success with output uses text fallback when no Markdown", () => {
  createProgressState("rend-4", "ok-agent", "a task");
  finalizeProgressState("rend-4", "final result text");
  const theme = makeTheme();
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
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolSuccessBg]") && line.endsWith("[/toolSuccessBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress cancelled state shows cancelled", () => {
  createProgressState("rend-5", "some-agent", "a task");
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
  expect(text).toContain("cancelled");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
    ),
  ).toBe(true);
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
});
