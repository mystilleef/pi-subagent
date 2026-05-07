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

const realDateNow = Date.now;

function setDateNow(now: number): void {
  Date.now = () => now;
}

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
  Date.now = realDateNow;
  clearProgressState("req-1");
  clearProgressState("req-2");
  clearProgressState("rend-live");
  clearProgressState("iso-success");
  clearProgressState("iso-error");
  clearProgressState("iso-running");
  for (let i = 1; i <= 12; i++) clearProgressState(`rend-${i}`);
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
  expect(state?.lastToolPreview).toBeUndefined();
  expect(state?.finalOutput).toBeUndefined();
  expect(state?.errorText).toBeUndefined();
});

test("getProgressState returns undefined for unknown request id", () => {
  expect(getProgressState("nonexistent")).toBeUndefined();
});

test("patchProgressState merges fields without replacing unpatched fields", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { toolCount: 3, lastToolPreview: "bash: ls" });
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(3);
  expect(state?.lastToolPreview).toBe("bash: ls");
  expect(state?.agent).toBe("agent-a");
  expect(state?.status).toBe("running");
});

test("finalizeProgressState sets success status and semantic final output", () => {
  createProgressState("req-1", "agent-a", "task a");
  finalizeProgressState("req-1", "all done");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("success");
  expect(state?.finalOutput).toBe("all done");
  expect(state?.errorText).toBeUndefined();
});

test("terminal final output uses outcome and leaves neutral text unprefixed", () => {
  createProgressState("req-1", "agent-a", "task a");
  finalizeProgressState("req-1", "noise\nOutcome: completed requested fix");
  expect(getProgressState("req-1")?.finalOutput).toBe(
    "completed requested fix",
  );
  createProgressState("req-2", "agent-b", "task b");
  finalizeProgressState("req-2", "Result: needs follow-up review");
  expect(getProgressState("req-2")?.finalOutput).toBe("needs follow-up review");
});

test("terminal success normalizes status prefixes labels and status-only output", () => {
  createProgressState("req-1", "agent-a", "task a");
  finalizeProgressState("req-1", "SUCCESS: SUCCESS");
  expect(getProgressState("req-1")?.finalOutput).toBe("completed task");
  createProgressState("req-2", "agent-b", "task b");
  finalizeProgressState("req-2", "SUCCESS");
  expect(getProgressState("req-2")?.finalOutput).toBe("completed task");
  createProgressState("iso-success", "agent-c", "task c");
  finalizeProgressState("iso-success", "DONE");
  expect(getProgressState("iso-success")?.finalOutput).toBe("completed task");
  createProgressState("iso-running", "agent-d", "task d");
  finalizeProgressState("iso-running", "Status: DONE");
  expect(getProgressState("iso-running")?.finalOutput).toBe("completed task");
  createProgressState("iso-error", "agent-e", "task e");
  finalizeProgressState("iso-error", "SUCCESS: Result: implemented fix");
  expect(getProgressState("iso-error")?.finalOutput).toBe("implemented fix");
});

test("terminal failure normalizes status prefixes and status-only text", () => {
  createProgressState("req-1", "agent-a", "task a");
  failProgressState("req-1", "FAILURE: child failed");
  expect(getProgressState("req-1")?.errorText).toBe("child failed");
  createProgressState("req-2", "agent-b", "task b");
  failProgressState("req-2", "FAILURE: FAILURE");
  expect(getProgressState("req-2")?.errorText).toBe("task failed");
  createProgressState("req-3", "agent-c", "task c");
  failProgressState("req-3", "Error: ERROR");
  expect(getProgressState("req-3")?.errorText).toBe("task failed");
  createProgressState("req-4", "agent-d", "task d");
  failProgressState("req-4", "FAILURE: Error: permission denied");
  expect(getProgressState("req-4")?.errorText).toBe("permission denied");
});

test("terminal helpers clear transient tool fields and compact semantic text", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "bash: noisy command" });
  const longOutcome = `Outcome: implemented ${"x".repeat(600)}`;
  finalizeProgressState("req-1", longOutcome);
  const successState = getProgressState("req-1");
  expect(successState?.lastToolPreview).toBeUndefined();
  expect(successState?.finalOutput).toStartWith("implemented ");
  expect(successState?.finalOutput).toEndWith("…");
  createProgressState("req-2", "agent-b", "task b");
  patchProgressState("req-2", { lastToolPreview: "read: /tmp/file" });
  const longCause = `migration failed ${"e".repeat(600)}`;
  failProgressState("req-2", longCause);
  const errorState = getProgressState("req-2");
  expect(errorState?.lastToolPreview).toBeUndefined();
  expect(errorState?.errorText).toStartWith("migration failed ");
  expect(errorState?.errorText).toEndWith("…");
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
  expect(getProgressState("req-1")?.errorText).toBe("bun test failed");
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

test("cancelProgressState sets cancelled status with unprefixed reason", () => {
  createProgressState("req-1", "agent-a", "task a");
  cancelProgressState("req-1", "Status: user aborted");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBe("user aborted");
});

test("cancelled progress ignores late tool previews", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "bash: running" });
  cancelProgressState("req-1", "user cancelled");
  patchProgressState("req-1", { lastToolPreview: "read: stale" });
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.lastToolPreview).toBeUndefined();
  expect(state?.errorText).toBe("user cancelled");
});

test("cancelProgressState with no reason leaves errorText undefined", () => {
  createProgressState("req-1", "agent-a", "task a");
  cancelProgressState("req-1");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBeUndefined();
});

test("terminal helpers capture deterministic duration", () => {
  setDateNow(1000);
  createProgressState("req-1", "agent-a", "task a");
  setDateNow(3450);
  finalizeProgressState("req-1", "all done");
  expect(getProgressState("req-1")?.durationMs).toBe(2450);
  setDateNow(2000);
  createProgressState("req-2", "agent-b", "task b");
  setDateNow(7600);
  failProgressState("req-2", "something exploded");
  expect(getProgressState("req-2")?.durationMs).toBe(5600);
});

test("terminal helper no-ops for missing state", () => {
  expect(() => finalizeProgressState("req-1", "all done")).not.toThrow();
  expect(getProgressState("req-1")).toBeUndefined();
});

test("terminal helpers preserve existing duration", () => {
  setDateNow(1000);
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { durationMs: 123 });
  setDateNow(9000);
  cancelProgressState("req-1", "user aborted");
  const state = getProgressState("req-1");
  expect(state?.durationMs).toBe(123);
  expect(state?.status).toBe("cancelled");
});

test("terminal durations stay isolated by request", () => {
  setDateNow(1000);
  createProgressState("iso-success", "agent-a", "task a");
  setDateNow(2000);
  createProgressState("iso-error", "agent-b", "task b");
  setDateNow(3000);
  createProgressState("iso-running", "agent-c", "task c");
  setDateNow(5500);
  finalizeProgressState("iso-success", "all done");
  expect(getProgressState("iso-success")?.durationMs).toBe(4500);
  expect(getProgressState("iso-error")?.durationMs).toBeUndefined();
  expect(getProgressState("iso-running")?.durationMs).toBeUndefined();
  setDateNow(9000);
  failProgressState("iso-error", "child failed");
  expect(getProgressState("iso-success")?.durationMs).toBe(4500);
  expect(getProgressState("iso-error")?.durationMs).toBe(7000);
  setDateNow(12_500);
  const theme = makeTheme();
  const runningResult = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "iso-running" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(runningResult)).toContain("9.5s");
  expect(getProgressState("iso-running")?.durationMs).toBeUndefined();
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

test("makeToolPreview leaves 120 displayed characters unchanged", () => {
  const command = "λ".repeat(114);
  const preview = makeToolPreview("bash", { command });
  expect(preview).toBe(`bash: ${command}`);
  expect(Array.from(preview).length).toBe(120);
  expect(preview.endsWith("…")).toBe(false);
});

test("makeToolPreview truncates long previews to 120 displayed characters", () => {
  const command = "λ".repeat(115);
  const preview = makeToolPreview("bash", { command });
  expect(Array.from(preview).length).toBe(120);
  expect(preview.endsWith("…")).toBe(true);
  expect(preview).toBe(`${"bash: "}${"λ".repeat(113)}…`);
});

test("makeToolPreview truncates long path preview after tool prefix", () => {
  const path = `/tmp/${"x".repeat(130)}`;
  const preview = makeToolPreview("read", { path });
  expect(Array.from(preview).length).toBe(120);
  expect(preview).toBe(`${"read: "}${path.slice(0, 113)}…`);
  expect(preview).not.toContain("x".repeat(115));
});

test("makeToolPreview omits unknown tool arguments", () => {
  const args = {
    token: "secret-token",
    password: "secret-password",
    nested: { value: "secret-nested" },
  };
  const preview = makeToolPreview("unknown_tool", args);
  expect(preview).toBe("unknown_tool");
  expect(preview).not.toContain(":");
  expect(preview).not.toContain("secret");
});

test("makeToolPreview truncates subagent semantic preview after tool prefix", () => {
  const preview = makeToolPreview("subagent", {
    agent: "builder",
    task: `${"review ".repeat(30)}sentinel`,
    agentScope: "project",
  });
  expect(Array.from(preview).length).toBe(120);
  expect(preview.startsWith("subagent: builder review review")).toBe(true);
  expect(preview.endsWith("…")).toBe(true);
  expect(preview).not.toContain("sentinel");
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
  expect(result.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails returns derived progress without messages", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  delete firstResult.messages;
  firstResult.progress = {
    toolCalls: [
      { id: "safe-1", preview: "bash: ls" },
      { id: "safe-2", preview: "read: /tmp/foo" },
    ],
    lastToolPreview: "read: /tmp/foo",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-1", "safe-2"]);
  expect(result.lastToolPreview).toBe("read: /tmp/foo");
  expect([...seen]).toEqual(["safe-1", "safe-2"]);
});

test("extractProgressFromDetails prefers derived progress over legacy messages", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "raw-1",
          name: "bash",
          arguments: { command: "secret-token" },
        },
      ],
    },
  ]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "safe-1", preview: "bash" }],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-1"]);
  expect(result.lastToolPreview).toBe("bash");
  expect(seen.has("raw-1")).toBe(false);
});

test("extractProgressFromDetails ignores malformed derived progress ids", () => {
  const details = makeDetails([]) as unknown as SubagentDetails;
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "safe-1", preview: "bash" },
      { id: 7, preview: "bad" },
      { id: "bad", preview: null },
    ] as unknown as { id: string; preview: string }[],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-1"]);
  expect(result.lastToolPreview).toBe("bash");
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
  expect(result.lastToolPreview).toBe("outer");
});

test("extractProgressFromDetails returns last tool preview", () => {
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
  expect(result.lastToolPreview).toBe("read: /tmp/foo");
});

test("extractProgressFromDetails omits unknown secret arguments", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-secret",
          name: "unknown_tool",
          arguments: {
            token: "secret-token",
            password: "secret-password",
            nested: { value: "secret-nested" },
          },
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("unknown_tool");
  expect(result.lastToolPreview).not.toContain(":");
  expect(result.lastToolPreview).not.toContain("secret");
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

test("renderSubagentProgress collapsed running colors tool preview segments", () => {
  setDateNow(1000);
  createProgressState("rend-1", "my-agent", "do the thing");
  setDateNow(3500);
  patchProgressState("rend-1", {
    toolCount: 3,
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
  expect(text).toContain("my-agent");
  expect(text).toContain("running");
  expect(text).toContain("3 tools · 8% ctx ·");
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
  patchProgressState("rend-2", { lastToolPreview: "bash" });
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

test("format header stats renders tool count context percent and elapsed", () => {
  expect(formatTokenCount(12345)).toBe("12.3k");
  const stats = formatHeaderStats({
    requestId: "req-1",
    agent: "agent-a",
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
  expect(stats).toBe("3 tools · 8% ctx · 2.5s\n");
  expect(stats).not.toContain("7.1k in");
  expect(stats).not.toContain("890 out");
});

test("format header stats pluralizes zero singular and plural tool counts", () => {
  const base = {
    requestId: "req-1",
    agent: "agent-a",
    taskPreview: "task a",
    status: "running" as const,
    startTime: 0,
    durationMs: 2500,
  };
  expect(formatHeaderStats({ ...base, toolCount: 0 })).toBe(
    "0 tools · --% ctx · 2.5s\n",
  );
  expect(formatHeaderStats({ ...base, toolCount: 1 })).toBe(
    "1 tool · --% ctx · 2.5s\n",
  );
  expect(formatHeaderStats({ ...base, toolCount: 2 })).toBe(
    "2 tools · --% ctx · 2.5s\n",
  );
});

test("format header stats handles zero usage and context fallbacks", () => {
  setDateNow(4000);
  const base = {
    requestId: "req-1",
    agent: "agent-a",
    taskPreview: "task a",
    status: "running" as const,
    startTime: 1000,
    toolCount: 0,
  };
  expect(formatHeaderStats(base)).toBe("0 tools · --% ctx · 3.0s\n");
  expect(
    formatHeaderStats({ ...base, contextTokens: -1, contextWindowTokens: 100 }),
  ).toBe("0 tools · 0% ctx · 3.0s\n");
  expect(
    formatHeaderStats({
      ...base,
      contextTokens: Number.NaN,
      contextWindowTokens: 100,
    }),
  ).toBe("0 tools · 0% ctx · 3.0s\n");
  expect(
    formatHeaderStats({ ...base, contextTokens: 50, contextWindowTokens: 0 }),
  ).toBe("0 tools · --% ctx · 3.0s\n");
  expect(
    formatHeaderStats({
      ...base,
      contextTokens: 50,
      contextWindowTokens: Number.POSITIVE_INFINITY,
    }),
  ).toBe("0 tools · --% ctx · 3.0s\n");
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
