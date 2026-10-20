import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  cancelProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  patchProgressState,
  resetProgressStore,
} from "../src/progress/progress.js";
import {
  getFeedbackSummaryText,
  patchProgressFromDetails,
  sanitizeDetailsForDisplay,
} from "../src/progress/result-details.js";
import type {
  SingleResult,
  SubagentDetails,
  SubagentToolResult,
  ToolActivity,
} from "../src/shared/types.js";
import { makeSingleResult } from "./helpers.js";

function makeToolResult(
  result: SingleResult,
  contentText = "parent content",
): SubagentToolResult {
  return {
    content: [{ type: "text", text: contentText }],
    details: {
      mode: "single",
      agentScope: "both",
      projectAgentsDir: null,
      results: [result],
    },
  };
}

test("feedback summary ignores stale parent content text", () => {
  const toolResult = makeToolResult(
    makeSingleResult({ finalOutput: "", outcome: " \t\n " }),
    "stale streaming activity text",
  );
  expect(getFeedbackSummaryText(toolResult)).toBe("(no output)");
});

describe("unconfirmed thinking progress propagation", () => {
  function makeDetailsWithModel(model: string): SubagentDetails {
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
          model,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        },
      ],
    };
  }

  test("patchProgressFromDetails propagates requested level to modelDisplay", () => {
    createProgressState("req-1", "agent-a", "task a");
    const seen = new Set<string>();
    patchProgressFromDetails(
      "req-1",
      makeDetailsWithModel("unknown ･ unknown ･ high"),
      seen,
    );
    expect(getProgressState("req-1")?.modelDisplay).toBe(
      "unknown ･ unknown ･ high",
    );
  });
});

test("sanitizeDetailsForDisplay redacts sensitive debug message content", () => {
  const details = makeDetails([
    {
      role: "assistant",
      usage: { input: 1, output: 2 },
      content: [
        { type: "text", text: "safe context" },
        { type: "text", text: "secret launch token" },
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: {
            command: "echo benign",
            token: "abc123",
            nested: { password: "hunter2" },
          },
        },
      ],
    },
  ]);
  const sanitized = sanitizeDetailsForDisplay(details, true);
  const messageJson = JSON.stringify(sanitized.results[0]?.messages);
  expect(sanitized.results[0]?.messages?.map((m) => m.role)).toEqual([
    "assistant",
  ]);
  expect(messageJson).toContain("safe context");
  expect(messageJson).toContain("echo benign");
  expect(messageJson).toContain("launch");
  expect(messageJson).toContain("usage");
  expect(messageJson).not.toContain("secret launch token");
  expect(messageJson).not.toContain("abc123");
  expect(messageJson).not.toContain("hunter2");
  expect(messageJson).toContain("[redacted] launch [redacted]");
});

test("sanitizeDetailsForDisplay handles unusual debug message shapes", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.messages = [
    null,
    "password inline",
    { role: "assistant", content: null },
    {
      role: "toolResult",
      content: [{ type: "text", text: ["token nested", "benign"] }],
      usage: { input: 1, output: 2 },
    },
  ] as unknown as Message[];
  const sanitized = sanitizeDetailsForDisplay(details, true);
  const messageJson = JSON.stringify(sanitized.results[0]?.messages);
  expect(messageJson).toContain("benign");
  expect(messageJson).toContain('"input":1');
  expect(messageJson).toContain("inline");
  expect(messageJson).toContain("nested");
  expect(messageJson).not.toContain("password inline");
  expect(messageJson).not.toContain("token nested");
});

test("sanitizeDetailsForDisplay preserves benign mixed debug detail", () => {
  const details = makeDetails([
    {
      role: "assistant",
      usage: { input: 3, output: 4, totalTokens: 7 },
      content: [
        {
          type: "text",
          text: "benign preface token=abc benign suffix",
        },
        {
          type: "toolCall",
          id: "tc-1",
          name: "write",
          arguments: {
            path: "safe.txt",
            metadata: { label: "benign field" },
            password: "hunter2",
          },
        },
      ],
    },
    {
      role: "user",
      usage: { input: 5, output: 0 },
      content: [{ type: "text", text: "ordinary follow up" }],
    },
  ]);
  const sanitized = sanitizeDetailsForDisplay(details, true);
  const messages = sanitized.results[0]?.messages ?? [];
  const messageJson = JSON.stringify(messages);
  expect(messages.map((message) => message.role)).toEqual([
    "assistant",
    "user",
  ]);
  expect(messageJson).toContain("benign preface");
  expect(messageJson).toContain("benign suffix");
  expect(messageJson).toContain("safe.txt");
  expect(messageJson).toContain("benign field");
  expect(messageJson).toContain("ordinary follow up");
  expect(messageJson).toContain('"input":3');
  expect(messageJson).not.toContain("token=abc");
  expect(messageJson).not.toContain("hunter2");
  expect(messageJson).toContain("[redacted]");
});

test("nested-only update changes running preview without changing toolCount", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading config.ts",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("Reading config.ts");
  expect(state?.toolCount).toBe(0);
  expect([...seen]).toEqual([]);
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
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: "bash: child-owned",
      },
    },
  };
  const seen = new Set<string>(["tc-child"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("subagent: build - bash: child-owned");
  expect(state?.requestId).toBe("req-1");
  expect(state?.agent).toBe("agent-a");
  expect(state?.instanceName).toBe("able-falcon");
  expect(state?.taskPreview).toBe("task a");
  expect(state?.status).toBe("running");
  expect(state?.toolCount).toBe(2);
  expect(state?.inputTokens).toBe(99);
  expect(state?.outputTokens).toBe(88);
  expect(state?.contextTokens).toBe(77);
  expect(state?.contextWindowTokens).toBe(66);
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

test("child default preview fallback after nested activity: message update repeats default child preview with no fresh tool-call IDs", () => {
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
  // activityText updates the activity and preview
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: ls",
  });
  expect(state?.lastToolPreview).toBe("bash: ls");
  expect(state?.inputTokens).toBe(200);
  expect(state?.outputTokens).toBe(80);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("child default preview fallback after nested activity: tool-result update repeats default child preview with no fresh tool-call IDs", () => {
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
  // activityText updates the activity and preview
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "read: /tmp/file",
  });
  expect(state?.lastToolPreview).toBe("read: /tmp/file");
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
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: childDefaultPreview,
      },
    },
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
  expect(state?.lastToolPreview).toBe("subagent: build - bash: ls");
  expect(state?.inputTokens).toBe(200);
  expect(state?.outputTokens).toBe(80);
  expect(state?.contextTokens).toBe(280);
  expect(state?.contextWindowTokens).toBe(1000);
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
  delete firstResult.progress;
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

test("activeToolActivity reset on fresh direct child tool call", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "tool", inputSummary: "nested old" },
    lastToolPreview: "nested old",
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-fresh", preview: "bash: new" }],
    activityText: "bash: new",
    lastToolPreview: "bash: new",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: new",
  });
  expect(state?.lastToolPreview).toBe("bash: new");
  expect([...seen]).toEqual(["tc-fresh"]);
});

test("activeToolActivity builds from parent subagent frame plus nested leaf", () => {
  createProgressState("req-1", "agent-a", "task a", "able-falcon");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
    },
    lastToolPreview: "subagent: build",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "bash: scan src",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: "bash: scan src",
      },
    },
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    child: {
      toolName: "bash",
      inputSummary: "bash: scan src",
    },
  });
  expect(state?.lastToolPreview).toBe("subagent: build - bash: scan src");
});

test("activeToolActivity preserves immutability across updates", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "first nested" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  const activity1 = getProgressState("req-1")?.activeToolActivity;
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = { toolCalls: [], activityText: "second nested" };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  const activity2 = getProgressState("req-1")?.activeToolActivity;
  expect(activity1).toEqual({ toolName: "tool", inputSummary: "first nested" });
  expect(activity2).toEqual({
    toolName: "tool",
    inputSummary: "second nested",
  });
  expect(activity1).not.toBe(activity2);
});

test("activeToolActivity preserves parent on nested tool_result_end completion", () => {
  createProgressState("req-1", "agent-a", "task a", "able-falcon");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "able-falcon",
      child: {
        toolName: "bash",
        inputSummary: "bash: scan src",
      },
    },
    lastToolPreview: "subagent: build [able-falcon] - bash: scan src",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "able-falcon",
      child: {
        toolName: "bash",
        inputSummary: "bash: scan src",
      },
    },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "able-falcon",
  });
  expect(state?.lastToolPreview).toBe("subagent: build [able-falcon]");
  expect(state?.toolResultCompleted).toBe(true);
});

test("activeToolActivity clears activity and preview when leaf completes with no parent", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: single" },
    lastToolPreview: "bash: single",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: { toolName: "bash", inputSummary: "bash: single" },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toBeUndefined();
  expect(state?.lastToolPreview).toBeUndefined();
  expect(state?.toolResultCompleted).toBe(true);
});

test("activeToolActivity tool_result_end does not mutate stored activity tree", () => {
  createProgressState("req-1", "agent-a", "task a");
  const storedActivity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "subagent: build",
    child: {
      toolName: "bash",
      inputSummary: "bash: ls",
    },
  };
  patchProgressState("req-1", {
    activeToolActivity: storedActivity,
    lastToolPreview: "subagent: build - bash: ls",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: "bash: ls",
      },
    },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  // Original stored tree is not mutated
  expect(storedActivity.child).toBeDefined();
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
  });
});

test.each([
  {
    name: "nested-only activity batch preserves token accounting",
    stateInputTokens: 100,
    stateOutputTokens: 50,
    stateContextTokens: 150,
    stateContextWindowTokens: 1000,
    activityText: "bash: scanning",
    childInputSummary: "bash: scanning",
    usageInput: 999,
    usageOutput: 888,
    usageContextTokens: 777,
    usageContextWindowTokens: 666,
    expectedToolPreview: "subagent: build - bash: scanning",
    expectedInputTokens: 999,
    expectedOutputTokens: 888,
    expectedContextTokens: 777,
    expectedContextWindowTokens: 666,
  },
  {
    name: "nested-only update applies token accounting when usage data is present",
    stateInputTokens: 40,
    stateOutputTokens: 20,
    stateContextTokens: 60,
    stateContextWindowTokens: 500,
    activityText: "bash: linting",
    childInputSummary: "bash: linting",
    usageInput: 300,
    usageOutput: 150,
    usageContextTokens: 450,
    usageContextWindowTokens: 2000,
    expectedToolPreview: "subagent: build - bash: linting",
    expectedInputTokens: 300,
    expectedOutputTokens: 150,
    expectedContextTokens: 450,
    expectedContextWindowTokens: 2000,
  },
])("$name", (row) => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "subagent: build - bash: ls",
    toolCount: 2,
    inputTokens: row.stateInputTokens,
    outputTokens: row.stateOutputTokens,
    contextTokens: row.stateContextTokens,
    contextWindowTokens: row.stateContextWindowTokens,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: row.activityText,
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: row.childInputSummary,
      },
    },
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: row.usageInput,
    output: row.usageOutput,
    contextTokens: row.usageContextTokens,
    contextWindowTokens: row.usageContextWindowTokens,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe(row.expectedToolPreview);
  expect(state?.toolCount).toBe(2);
  expect(state?.inputTokens).toBe(row.expectedInputTokens);
  expect(state?.outputTokens).toBe(row.expectedOutputTokens);
  expect(state?.contextTokens).toBe(row.expectedContextTokens);
  expect(state?.contextWindowTokens).toBe(row.expectedContextWindowTokens);
});

test("patchProgressFromDetails extracts and propagates toolResultCompleted", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.toolResultCompleted).toBe(true);
});

test("activeToolActivity preserved on progress update with no tool calls or activity", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "tool", inputSummary: "existing" },
    lastToolPreview: "existing",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [] };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "existing",
  });
  expect(state?.lastToolPreview).toBe("existing");
});

test("depth-3 activity tree composition through child progress details", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "subagent",
        inputSummary: "subagent: review",
        instanceName: "sharp-finch",
        child: {
          toolName: "bash",
          inputSummary: "bash: make build",
        },
      },
    },
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
    child: {
      toolName: "subagent",
      inputSummary: "subagent: review",
      instanceName: "sharp-finch",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
  });
  expect(state?.lastToolPreview).toBe(
    "subagent: build [swift-harbor] - subagent: review [sharp-finch] - bash: make build",
  );
});

test("depth-3 activity tree strips leaf child on tool_result_end", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "subagent",
        inputSummary: "subagent: review",
        instanceName: "sharp-finch",
        child: {
          toolName: "bash",
          inputSummary: "bash: make build",
        },
      },
    },
    lastToolPreview:
      "subagent: build [swift-harbor] - subagent: review [sharp-finch] - bash: make build",
    toolCount: 2,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "subagent",
        inputSummary: "subagent: review",
        instanceName: "sharp-finch",
        child: {
          toolName: "bash",
          inputSummary: "bash: make build",
        },
      },
    },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  // toolResultCompleted strips the immediate child (entire subtree)
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
  });
  expect(state?.lastToolPreview).toBe("subagent: build [swift-harbor]");
  expect(state?.toolResultCompleted).toBe(true);
});

test("back-to-back nested completion preserves accumulated tokens through child strip transition", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
    lastToolPreview: "subagent: build [swift-harbor] - bash: make build",
    toolCount: 3,
    inputTokens: 100,
    outputTokens: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  });
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = {
    toolCalls: [],
    activityText: "bash: make build",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
    toolResultCompleted: true,
  };
  r1.usage = {
    ...r1.usage,
    input: 999,
    output: 888,
    contextTokens: 777,
    contextWindowTokens: 1000,
  };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  const state1 = getProgressState("req-1");
  expect(state1?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
  });
  expect(state1?.lastToolPreview).toBe("subagent: build [swift-harbor]");
  expect(state1?.inputTokens).toBe(999);
  expect(state1?.outputTokens).toBe(888);
  expect(state1?.contextTokens).toBe(777);
  expect(state1?.contextWindowTokens).toBe(1000);
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-post-strip", preview: "bash: echo done" }],
    activityText: "bash: echo done",
    lastToolPreview: "bash: echo done",
  };
  r2.usage = {
    ...r2.usage,
    input: 200,
    output: 100,
    contextTokens: 300,
    contextWindowTokens: 1000,
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  const state2 = getProgressState("req-1");
  expect(state2?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: echo done",
  });
  expect(state2?.lastToolPreview).toBe("bash: echo done");
  expect(state2?.inputTokens).toBe(200);
  expect(state2?.outputTokens).toBe(100);
  expect(state2?.contextTokens).toBe(300);
});

test("child repeating same preview updates tokens without changing activity", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
    toolCount: 1,
    inputTokens: 50,
    outputTokens: 25,
    contextTokens: 75,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "bash: ls",
    lastToolPreview: "bash: ls",
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 100,
    output: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["tc-1"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: ls",
  });
  expect(state?.lastToolPreview).toBe("bash: ls");
  expect(state?.toolCount).toBe(1);
  expect(state?.inputTokens).toBe(100);
  expect(state?.outputTokens).toBe(50);
});

test("activityText without activeToolActivity builds single-node activity tree", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "tool", inputSummary: "Reading file.ts" },
    lastToolPreview: "Reading file.ts",
    toolCount: 1,
    inputTokens: 50,
    outputTokens: 25,
    contextTokens: 75,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading file.ts",
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 100,
    output: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "Reading file.ts",
  });
  expect(state?.lastToolPreview).toBe("Reading file.ts");
  expect(state?.toolCount).toBe(1);
  expect(state?.inputTokens).toBe(100);
  expect(state?.outputTokens).toBe(50);
});

test("new activityText replaces existing activity tree and updates preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "tool", inputSummary: "Reading file.ts" },
    lastToolPreview: "Reading file.ts",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Scanning src directory",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "Scanning src directory",
  });
  expect(state?.lastToolPreview).toBe("Scanning src directory");
  expect(state?.toolCount).toBe(1);
});

test("activityText without tree replaces multi-level activity with single node", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: { toolName: "bash", inputSummary: "bash: ls" },
    },
    lastToolPreview: "subagent: build - bash: ls",
    toolCount: 2,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "bash: ls",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  // activityText builds a single-node tree, replacing the multi-level one
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: ls",
  });
  expect(state?.lastToolPreview).toBe("bash: ls");
  expect(state?.toolCount).toBe(2);
});

test("nested activity details update parent and append child in activity tree", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
    },
    lastToolPreview: "subagent: build",
    toolCount: 2,
    inputTokens: 100,
    outputTokens: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "bash: scanning src",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: scanning src",
      },
    },
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 999,
    output: 888,
    contextTokens: 777,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
    child: {
      toolName: "bash",
      inputSummary: "bash: scanning src",
    },
  });
  expect(state?.lastToolPreview).toBe(
    "subagent: build [swift-harbor] - bash: scanning src",
  );
  expect(state?.toolCount).toBe(2);
  expect(state?.inputTokens).toBe(999);
  expect(state?.outputTokens).toBe(888);
  expect(state?.contextTokens).toBe(777);
  expect(state?.contextWindowTokens).toBe(1000);
});

test("depth-2 parent activity remains visible after child tool_result_end", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
    lastToolPreview: "subagent: build [swift-harbor] - bash: make build",
    toolCount: 2,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
  });
  expect(state?.lastToolPreview).toBe("subagent: build [swift-harbor]");
  expect(state?.toolResultCompleted).toBe(true);
});

test("patchProgressFromDetails copies latestResult.model to modelDisplay", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = "claude-3-5-sonnet";
  firstResult.usage = {
    ...firstResult.usage,
    input: 10,
    output: 5,
    contextTokens: 15,
    contextWindowTokens: 100,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.modelDisplay).toBe("claude-3-5-sonnet");
  expect(getProgressState("req-1")?.inputTokens).toBe(10);
  expect(getProgressState("req-1")?.outputTokens).toBe(5);
});

test("patchProgressFromDetails does not set modelDisplay when model is undefined", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = undefined;
  firstResult.usage = {
    ...firstResult.usage,
    input: 10,
    output: 5,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
  expect(getProgressState("req-1")?.inputTokens).toBe(10);
});

test.each([
  {
    name: "patchProgressFromDetails does not set modelDisplay when model is empty string",
    model: "",
  },
  {
    name: "patchProgressFromDetails does not set modelDisplay when model is whitespace-only string",
    model: "   ",
  },
])("$name", (row) => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = row.model;
  firstResult.usage = {
    ...firstResult.usage,
    input: 10,
    output: 5,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
  expect(getProgressState("req-1")?.inputTokens).toBe(10);
});

test("patchProgressFromDetails does not throw when details have no results", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [],
  };
  const seen = new Set<string>();
  expect(() => patchProgressFromDetails("req-1", details, seen)).not.toThrow();
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
});

test("patchProgressFromDetails updates modelDisplay alongside existing usage metric patching", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    toolCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    contextTokens: 15,
    contextWindowTokens: 100,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = "gpt-4o";
  firstResult.usage = {
    ...firstResult.usage,
    input: 20,
    output: 10,
    contextTokens: 30,
    contextWindowTokens: 200,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.modelDisplay).toBe("gpt-4o");
  expect(getProgressState("req-1")?.inputTokens).toBe(20);
  expect(getProgressState("req-1")?.outputTokens).toBe(10);
  expect(getProgressState("req-1")?.contextTokens).toBe(30);
  expect(getProgressState("req-1")?.contextWindowTokens).toBe(200);
  expect(getProgressState("req-1")?.toolCount).toBe(1);
});

test("patchProgressFromDetails does not throw when no progress state exists", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = "claude-3-5-sonnet";
  const seen = new Set<string>();
  expect(() => patchProgressFromDetails("req-1", details, seen)).not.toThrow();
  expect(getProgressState("req-1")).toBeUndefined();
});

test.each([
  {
    name: "getFeedbackSummaryText prefers outcome from SingleResult inside details",
    finalOutput: "raw final output",
    outcome: "Exhaustive testing verified successfully!",
    expected: "exhaustive testing verified successfully",
  },
  {
    name: "getFeedbackSummaryText falls back when outcome is blank or missing",
    finalOutput: "Outcome: Falls back to finalOutput",
    outcome: "  ",
    expected: "outcome: falls back to finaloutput",
  },
])("$name", (row) => {
  const {
    getFeedbackSummaryText,
  } = require("../src/progress/result-details.js");
  const toolResult = {
    content: [{ type: "text", text: "raw text content" }],
    details: {
      mode: "single",
      agentScope: "project",
      projectAgentsDir: null,
      results: [
        {
          agent: "tester",
          agentSource: "project",
          task: "check",
          exitCode: 0,
          finalOutput: row.finalOutput,
          outcome: row.outcome,
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
        },
      ],
    },
  };
  expect(getFeedbackSummaryText(toolResult)).toBe(row.expected);
});

function makeDetails(
  messages: { role: string; content: unknown[]; usage?: unknown }[],
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

const realDateNow = Date.now;

afterEach(() => {
  Date.now = realDateNow;
  resetProgressStore();
});
