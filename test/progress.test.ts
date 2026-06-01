import { afterEach, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  formatElapsed,
  formatHeaderStats,
  getProgressState,
  makeTaskPreview,
  makeToolPreview,
  patchProgressState,
  renderSubagentProgress,
  resetProgressStore,
} from "../src/progress/progress.js";
import { getAllProgressStates } from "../src/progress/progress-state.js";
import { patchProgressFromDetails } from "../src/progress/result-details.js";
import type { SubagentDetails } from "../src/shared/types.js";

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
  clearProgressState("inv-1");
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

test("makeToolPreview collapses multiline whitespace", () => {
  const preview = makeToolPreview("bash", {
    command: "printf 'a'\n\t  echo b",
  });
  expect(preview).toBe("bash: printf 'a' echo b");
  expect(preview).not.toContain("\n");
});

test("makeToolPreview truncates after whitespace normalization", () => {
  const command = `${"x".repeat(100)}\n\t${"y".repeat(40)}`;
  const preview = makeToolPreview("bash", { command });
  expect(Array.from(preview).length).toBe(120);
  expect(preview).toBe(`${"bash: "}${"x".repeat(100)} ${"y".repeat(12)}…`);
  expect(preview).not.toContain("\n");
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

test("makeToolPreview omits blank semantic targets", () => {
  expect(makeToolPreview("bash", { command: "\n\t  " })).toBe("bash");
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

test("extractProgressFromDetails normalizes derived progress previews", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "safe-1", preview: "bash: printf 'a'\n\t  echo b" },
      { id: "safe-2", preview: `read: /tmp/foo\n${"x".repeat(130)}` },
    ],
  };
  const seen = new Set<string>(["safe-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-2"]);
  expect(result.lastToolPreview).toBe(`read: /tmp/foo ${"x".repeat(104)}…`);
  expect([...seen]).toEqual(["safe-1", "safe-2"]);
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

test("extractProgressFromDetails returns undefined lastToolPreview but populated activityText when all derived progress tool calls are already seen", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-1", preview: "bash: ls" },
      { id: "tc-2", preview: "read: /tmp/file" },
    ],
    activityText: "read: /tmp/file",
    lastToolPreview: "read: /tmp/file",
  };
  const seen = new Set(["tc-1", "tc-2"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("read: /tmp/file");
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

test("extractProgressFromDetails returns activityText from nested activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading file.ts",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("Reading file.ts");
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails prefers child tool preview over nested activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "Reading file.ts",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.activityText).toBe("Reading file.ts");
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("extractProgressFromDetails does not create tool-call IDs for nested activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Scanning codebase",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(seen.size).toBe(0);
});

test("extractProgressFromDetails normalizes and truncates nested activity text", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const longActivity = `${"x".repeat(150)}`;
  firstResult.progress = {
    toolCalls: [],
    activityText: `Reading ${longActivity}`,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeDefined();
  const chars = Array.from(result.activityText ?? "");
  expect(chars.length).toBeLessThanOrEqual(120);
  expect(result.activityText).toEndWith("…");
});

test("nested-only update changes running preview without changing toolCount", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading config.ts",
    lastToolPreview: undefined,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("Reading config.ts");
  expect(state?.toolCount).toBe(0);
  expect([...seen]).toEqual([]);
});

test("child-owned tool updates regain preview precedence after nested activity", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "Nested: scanning files" });
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Nested: scanning files",
  );
  patchProgressState("req-1", {
    lastToolPreview: "bash: ls -la",
    toolCount: 1,
  });
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("bash: ls -la");
  expect(state?.toolCount).toBe(1);
});

test("terminal states clear nested activity preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "Nested: reading file.ts" });
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Nested: reading file.ts",
  );
  finalizeProgressState("req-1", "all done");
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  createProgressState("req-2", "agent-b", "task b");
  patchProgressState("req-2", { lastToolPreview: "Nested: scanning" });
  failProgressState("req-2", "child failed");
  expect(getProgressState("req-2")?.lastToolPreview).toBeUndefined();
  createProgressState("req-3", "agent-c", "task c");
  patchProgressState("req-3", { lastToolPreview: "Nested: working" });
  cancelProgressState("req-3", "user aborted");
  expect(getProgressState("req-3")?.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails ignores whitespace-only activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "   ",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails ignores empty activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails ignores non-string activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: 42 as unknown as string,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails normalizes nested activity whitespace", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading file.ts\n\twith tabs",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("Reading file.ts with tabs");
});

test("extractProgressFromDetails redacts sensitive nested activity keywords", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading secret-token.yaml",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("Reading secret-token.yaml");
});

test("extractProgressFromDetails updates seen set without tool-call drift from activity", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-child",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    },
  ]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: ls" }],
    activityText: "Nested: reading file.ts",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-child"]);
  expect([...seen]).toEqual(["tc-child"]);
  expect(result.activityText).toBe("Nested: reading file.ts");
});

test("extractProgressFromDetails ignores already-seen derived previews with activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: stale" }],
    activityText: "Nested: reading fresh.ts",
    lastToolPreview: "bash: stale",
  };
  const seen = new Set<string>(["tc-child"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("Nested: reading fresh.ts");
  expect([...seen]).toEqual(["tc-child"]);
});

test("extractProgressFromDetails keeps last fresh preview ahead of repeated IDs", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-child", preview: "bash: fresh" },
      { id: "tc-child", preview: "bash: stale" },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-child"]);
  expect(result.lastToolPreview).toBe("bash: fresh");
  expect([...seen]).toEqual(["tc-child"]);
});

test("patchProgressFromDetails uses nested activity when child tool id repeats", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "bash: original",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: changed" }],
    activityText: "Nested: reading fresh.ts",
    lastToolPreview: "bash: changed",
  };
  const seen = new Set<string>(["tc-child"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("Nested: reading fresh.ts");
  expect(state?.toolCount).toBe(1);
  expect([...seen]).toEqual(["tc-child"]);
});

test("patchProgressFromDetails preserves parent fields during nested-only updates", () => {
  createProgressState("req-1", "agent-a", "task a", "able-falcon");
  patchProgressState("req-1", {
    lastToolPreview: "bash: child-owned",
    toolCount: 2,
    inputTokens: 10,
    outputTokens: 5,
    contextTokens: 15,
    contextWindowTokens: 100,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.agent = "other-agent";
  firstResult.instanceName = "other-instance";
  firstResult.task = "other task";
  firstResult.exitCode = 1;
  firstResult.finalOutput = "SHOULD_NOT_COPY";
  firstResult.usage = {
    ...firstResult.usage,
    input: 99,
    output: 88,
    contextTokens: 77,
    contextWindowTokens: 66,
  };
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: child-owned" }],
    activityText: "Nested: reading fresh.ts",
    lastToolPreview: "bash: child-owned",
  };
  const seen = new Set<string>(["tc-child"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("Nested: reading fresh.ts");
  expect(state?.requestId).toBe("req-1");
  expect(state?.agent).toBe("agent-a");
  expect(state?.instanceName).toBe("able-falcon");
  expect(state?.taskPreview).toBe("task a");
  expect(state?.status).toBe("running");
  expect(state?.toolCount).toBe(2);
  expect(state?.inputTokens).toBe(10);
  expect(state?.outputTokens).toBe(5);
  expect(state?.contextTokens).toBe(15);
  expect(state?.contextWindowTokens).toBe(100);
  expect(state?.finalOutput).toBeUndefined();
  expect(state?.errorText).toBeUndefined();
  expect(firstResult.progress.toolCalls).toEqual([
    { id: "tc-child", preview: "bash: child-owned" },
  ]);
  expect([...seen]).toEqual(["tc-child"]);
});

test("patchProgressFromDetails gives fresh child tool preview precedence", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "Nested: scanning" });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-fresh", preview: "bash: ls -la" }],
    activityText: "Nested: stale scan",
    lastToolPreview: "bash: ls -la",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("bash: ls -la");
  expect(state?.toolCount).toBe(1);
  expect([...seen]).toEqual(["tc-fresh"]);
});

test("patchProgressFromDetails maintains lastToolPreview via activityText fallback on repeated update with no new tool calls", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "bash: ls",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
});

test("child default preview fallback: extractProgressFromDetails returns no new tool-call IDs when all child IDs are already seen", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = "bash: ls";
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: childDefaultPreview }],
    activityText: childDefaultPreview,
    lastToolPreview: childDefaultPreview,
  };
  const seen = new Set<string>(["child-tool-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.activityText).toBe(childDefaultPreview);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("child default preview fallback after nested activity: message update repeats default child preview with no fresh child tool-call IDs", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: scanning codebase",
    toolCount: 2,
    inputTokens: 100,
    outputTokens: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = "bash: ls";
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: childDefaultPreview }],
    activityText: childDefaultPreview,
    lastToolPreview: childDefaultPreview,
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 200,
    output: 80,
    contextTokens: 280,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(2);
  expect(state?.lastToolPreview).toBe("Nested: scanning codebase");
  expect(state?.inputTokens).toBe(200);
  expect(state?.outputTokens).toBe(80);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("child default preview fallback after nested activity: tool-result update repeats default child preview with no fresh child tool-call IDs", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: reading config.ts",
    toolCount: 3,
    inputTokens: 150,
    outputTokens: 60,
    contextTokens: 210,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = "read: /tmp/file";
  firstResult.progress = {
    toolCalls: [
      { id: "child-tool-1", preview: "bash: ls" },
      { id: "child-tool-2", preview: childDefaultPreview },
    ],
    activityText: childDefaultPreview,
    lastToolPreview: childDefaultPreview,
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 300,
    output: 120,
    contextTokens: 420,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["child-tool-1", "child-tool-2"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(3);
  expect(state?.lastToolPreview).toBe("Nested: reading config.ts");
  expect(state?.inputTokens).toBe(300);
  expect(state?.outputTokens).toBe(120);
  expect([...seen]).toEqual(["child-tool-1", "child-tool-2"]);
});

test("fresh child tool-call ID distinguishes normal preview update from child default preview fallback", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: scanning codebase",
    toolCount: 2,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "child-tool-seen", preview: "bash: ls" },
      { id: "child-tool-fresh", preview: "read: /tmp/new" },
    ],
    activityText: "read: /tmp/new",
    lastToolPreview: "read: /tmp/new",
  };
  const seen = new Set<string>(["child-tool-seen"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(3);
  expect(state?.lastToolPreview).toBe("read: /tmp/new");
  expect([...seen]).toEqual(["child-tool-seen", "child-tool-fresh"]);
});

test("child default preview fallback fixture preserves normalization truncation seen-tool tracking and usage observability", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = `bash: ${"x".repeat(150)}`;
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: childDefaultPreview }],
    activityText: childDefaultPreview,
    lastToolPreview: childDefaultPreview,
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 120,
    output: 45,
    contextTokens: 165,
    contextWindowTokens: 500,
  };
  const seen = new Set<string>(["child-tool-1"]);
  const extracted = extractProgressFromDetails(details, seen);
  expect(extracted.activityText).toBeDefined();
  const activityChars = Array.from(extracted.activityText ?? "");
  expect(activityChars.length).toBeLessThanOrEqual(120);
  expect(extracted.activityText).toEndWith("…");
  expect(extracted.activityText).not.toContain("\n");
  expect(extracted.newToolCallIds).toEqual([]);
  expect([...seen]).toEqual(["child-tool-1"]);
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: prior activity",
    toolCount: 1,
  });
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  const previewChars = Array.from(state?.lastToolPreview ?? "");
  expect(previewChars.length).toBeLessThanOrEqual(120);
  expect(state?.toolCount).toBe(1);
  expect(state?.inputTokens).toBe(120);
  expect(state?.outputTokens).toBe(45);
  expect(state?.contextTokens).toBe(165);
  expect(state?.contextWindowTokens).toBe(500);
});

test("successive nested activity updates replace prior preserved nested preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details1 = makeDetails([]);
  const r1 = details1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const seen1 = new Set<string>();
  patchProgressFromDetails("req-1", details1, seen1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  expect(getProgressState("req-1")?.toolCount).toBe(0);
  const details2 = makeDetails([]);
  const r2 = details2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = { toolCalls: [], activityText: "Scanning src directory" };
  const seen2 = new Set<string>();
  patchProgressFromDetails("req-1", details2, seen2);
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Scanning src directory",
  );
  expect(getProgressState("req-1")?.toolCount).toBe(0);
});

test("fresh child tool call via patchProgressFromDetails supersedes nested activity set via patchProgressFromDetails", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details1 = makeDetails([]);
  const r1 = details1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const seen1 = new Set<string>();
  patchProgressFromDetails("req-1", details1, seen1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  const details2 = makeDetails([]);
  const r2 = details2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-fresh", preview: "bash: echo hello" }],
    activityText: "bash: echo hello",
    lastToolPreview: "bash: echo hello",
  };
  const seen2 = new Set<string>();
  patchProgressFromDetails("req-1", details2, seen2);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("bash: echo hello");
  expect(state?.toolCount).toBe(1);
  expect([...seen2]).toEqual(["tc-fresh"]);
});

test("supersession chain: nested activity then fresh child tool then new nested activity", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  expect(getProgressState("req-1")?.toolCount).toBe(0);
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "bash: ls",
    lastToolPreview: "bash: ls",
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
  expect(getProgressState("req-1")?.toolCount).toBe(1);
  const d3 = makeDetails([]);
  const r3 = d3.results[0];
  if (!r3) throw new Error("missing result");
  r3.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "Scanning dependencies",
    lastToolPreview: "bash: ls",
  };
  const s3 = new Set<string>(["tc-1"]);
  patchProgressFromDetails("req-1", d3, s3);
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Scanning dependencies",
  );
  expect(getProgressState("req-1")?.toolCount).toBe(1);
});

test("terminal success clears preserved nested activity and rejects late patchProgressFromDetails preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  finalizeProgressState("req-1", "all done");
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("success");
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-late", preview: "bash: stale" }],
    activityText: "bash: stale",
    lastToolPreview: "bash: stale",
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("success");
});

test("terminal error clears preserved nested activity and rejects late patchProgressFromDetails preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  failProgressState("req-1", "child failed");
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("error");
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-late", preview: "bash: stale" }],
    activityText: "bash: stale",
    lastToolPreview: "bash: stale",
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("error");
});

test("terminal cancellation clears preserved nested activity and rejects late patchProgressFromDetails preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  cancelProgressState("req-1", "user aborted");
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("cancelled");
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-late", preview: "bash: stale" }],
    activityText: "bash: stale",
    lastToolPreview: "bash: stale",
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("cancelled");
});

test("nested activity passes through when activityText differs from child progress lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Prior nested activity",
    toolCount: 2,
    inputTokens: 100,
    outputTokens: 50,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = "bash: ls";
  const genuineActivity = "Scanning utils";
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: childDefaultPreview }],
    activityText: genuineActivity,
    lastToolPreview: childDefaultPreview,
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 200,
    output: 80,
    contextTokens: 280,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(2);
  expect(state?.lastToolPreview).toBe(genuineActivity);
  expect(state?.inputTokens).toBe(100);
  expect(state?.outputTokens).toBe(50);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("repeated identical nested activity update is a no-op when stored preview matches incoming preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const nestedPreview = "Reading config.ts";
  patchProgressState("req-1", {
    lastToolPreview: nestedPreview,
    toolCount: 1,
    inputTokens: 100,
    outputTokens: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: nestedPreview }],
    activityText: nestedPreview,
    lastToolPreview: nestedPreview,
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 100,
    output: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(1);
  expect(state?.lastToolPreview).toBe(nestedPreview);
  expect(state?.inputTokens).toBe(100);
  expect(state?.outputTokens).toBe(50);
  expect(state?.contextTokens).toBe(150);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("default fallback detection allows update when stored progress has no lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: "bash: ls" }],
    activityText: "bash: ls",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
  expect(getProgressState("req-1")?.toolCount).toBe(0);
});

test("default fallback detection returns false when child has no activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: "bash: ls" }],
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>(["child-tool-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual([]);
});

test("default fallback detection skips when activityText mismatches child progress lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: scanning",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: "bash: ls" }],
    activityText: "genuine nested activity",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "genuine nested activity",
  );
});

test("default fallback detection handles empty progress with no fields set", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: prior",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [] };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(1);
  expect(state?.lastToolPreview).toBe("Nested: prior");
});

test("extractProgressFromDetails skips non-string progress lastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "scanning",
    lastToolPreview: 123 as unknown as string,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("scanning");
  expect(result.lastToolPreview).toBe("bash: ls");
});

test("extractProgressFromDetails skips empty progress lastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "scanning",
    lastToolPreview: "   ",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("scanning");
});

test("extractProgressFromDetails captures activityText and progressLastToolPreview independently", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "genuine nested activity",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("genuine nested activity");
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("patchProgressFromDetails handles details with no results gracefully", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [],
  };
  const seen = new Set<string>();
  expect(() => patchProgressFromDetails("req-1", details, seen)).not.toThrow();
  expect(getProgressState("req-1")?.toolCount).toBe(0);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
});

test("patchProgressFromDetails handles undefined effectivePreview gracefully", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { toolCount: 1 });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [] };
  firstResult.usage = {
    ...firstResult.usage,
    input: 50,
    output: 30,
    contextTokens: 80,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.toolCount).toBe(1);
  expect(getProgressState("req-1")?.inputTokens).toBe(50);
  expect(getProgressState("req-1")?.outputTokens).toBe(30);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
});

test("nested-only update detection returns false when latestResult progress is missing", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = undefined;
  firstResult.messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    },
  ] as unknown as Message[];
  firstResult.usage = {
    ...firstResult.usage,
    input: 50,
    output: 30,
    contextTokens: 80,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.toolCount).toBe(1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
  expect(getProgressState("req-1")?.inputTokens).toBe(50);
});

test("nested-only update allows usage when previous progress has matching activityText and lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details1 = makeDetails([]);
  const r1 = details1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = {
    toolCalls: [{ id: "tc-1", preview: "Read" }],
    activityText: "Read",
    lastToolPreview: "Read",
  };
  const seen1 = new Set<string>();
  patchProgressFromDetails("req-1", details1, seen1);
  const details2 = makeDetails([]);
  const r2 = details2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-1", preview: "Read" }],
    activityText: "Read",
    lastToolPreview: "Read",
  };
  r2.usage = {
    ...r2.usage,
    input: 100,
    output: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  };
  const seen2 = new Set<string>(["tc-1"]);
  patchProgressFromDetails("req-1", details2, seen2);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("Read");
  expect(state?.inputTokens).toBe(100);
  expect(state?.outputTokens).toBe(50);
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
  patchProgressState("rend-2", { instanceName: undefined });
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
  expect(stats).toBe("3 tools · 8% ctx · 2.5s\n");
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
    instanceName: "able-falcon",
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
test("getAllProgressStates returns empty array for empty store", () => {
  resetProgressStore();
  expect(getAllProgressStates()).toEqual([]);
});
test("getAllProgressStates returns all states sorted by startTime desc", () => {
  resetProgressStore();
  createProgressState("sort-a", "agent-a", "task-a");
  createProgressState("sort-b", "agent-b", "task-b");
  createProgressState("sort-c", "agent-c", "task-c");
  const states = getAllProgressStates();
  expect(states).toHaveLength(3);
  const requestIds = states.map((s) => s.requestId);
  // Creation order is a, b, c but startTime may vary slightly.
  // Verify sort is descending: startTime[i] >= startTime[i+1].
  for (let i = 0; i < states.length - 1; i++) {
    const a = states[i];
    const b = states[i + 1];
    if (a && b) {
      expect(a.startTime).toBeGreaterThanOrEqual(b.startTime);
    }
  }
  // All expected request ids are present.
  expect(requestIds).toContain("sort-a");
  expect(requestIds).toContain("sort-b");
  expect(requestIds).toContain("sort-c");
  resetProgressStore();
});
