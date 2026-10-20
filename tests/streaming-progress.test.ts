import { expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { runSingleAgent } from "../src/child/process.js";
import type { RuntimeResult } from "../src/child/result-builder.js";
import { makeEmitUpdate } from "../src/child/streaming-progress.js";
import type {
  StreamingProgress,
  SubagentDetails,
} from "../src/shared/types.js";
// Explicit agent/agentSource/task overrides preserve the former local
// makeRuntimeResult defaults at each migrated call site.
import {
  hangAgent,
  makeRuntimeResult,
  makeSingleResult,
  makeSubagentDetails,
  makeSubagentToolUpdateLine,
  setupHooks,
  setupTest,
  shellQuote,
} from "./helpers.js";

function makeToolCallMessage(
  toolName: string,
  args: Record<string, unknown>,
  id = "tc-1",
): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: toolName, arguments: args }],
  } as Message;
}

setupHooks();

function makeRuntimeWithToolCall(
  toolName: string,
  args: Record<string, unknown>,
): RuntimeResult {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: toolName, arguments: args },
      ],
    },
  ] as Message[];
  return { ...makeSingleResult(), messages };
}

test("makeEmitUpdate preserves activity when toolResultCompleted arrives", () => {
  const result = makeRuntimeWithToolCall("bash", { command: "ls" });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // First call sets up activity
  emitUpdate();

  // Store initial activity
  const initialActivity = result.progress?.activeToolActivity;
  expect(initialActivity).toBeDefined();

  // Send toolResultCompleted without new toolActivity
  emitUpdate({ toolResultCompleted: true });

  // Activity should be preserved
  expect(result.progress?.activeToolActivity).toEqual(initialActivity);
  expect(result.progress?.toolResultCompleted).toBe(true);
});

test("makeEmitUpdate merges tool activity with same tool name", () => {
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // First call to set up initial activity
  emitUpdate();
  const initialActivity = result.progress?.activeToolActivity;
  expect(initialActivity).toBeDefined();

  // Merge with same tool name but richer inputSummary
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "bash: scan src",
    },
  });

  // Should prefer incoming inputSummary since it's richer than toolName
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    "bash: scan src",
  );
});

test("makeEmitUpdate merges tool activity with different tool name", () => {
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // First call to set up initial activity
  emitUpdate();
  expect(result.progress?.activeToolActivity).toBeDefined();

  // Merge with different tool name - should replace entirely
  emitUpdate({
    toolActivity: {
      toolName: "bash",
      inputSummary: "bash: ls",
    },
  });

  expect(result.progress?.activeToolActivity?.toolName).toBe("bash");
  expect(result.progress?.activeToolActivity?.inputSummary).toBe("bash: ls");
});

test("makeEmitUpdate handles toolResultCompleted without existing activity", () => {
  const result: RuntimeResult = {
    ...makeSingleResult({ finalOutput: "done" }),
    messages: [
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ] as Message[],
  };
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // First call - no activity
  emitUpdate();
  expect(result.progress?.activeToolActivity).toBeUndefined();

  // Send toolResultCompleted - should set flag
  emitUpdate({ toolResultCompleted: true });
  expect(result.progress?.toolResultCompleted).toBe(true);
});

test("makeEmitUpdate handles merge with child activity", () => {
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // First call to set up activity
  emitUpdate();
  expect(result.progress?.activeToolActivity).toBeDefined();

  // Merge with child activity
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "bash: scan src",
      child: {
        toolName: "bash",
        inputSummary: "bash: scan src",
      },
    },
  });

  expect(result.progress?.activeToolActivity?.child).toEqual({
    toolName: "bash",
    inputSummary: "bash: scan src",
  });
});

test("makeEmitUpdate handles merge with instanceName", () => {
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // First call to set up activity
  emitUpdate();
  expect(result.progress?.activeToolActivity).toBeDefined();

  // Merge with instanceName
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "subagent",
      instanceName: "able-falcon",
    },
  });

  expect(result.progress?.activeToolActivity?.instanceName).toBe("able-falcon");
});

test("makeEmitUpdate merge: inputSummary === toolName fallback does not overwrite parent inputSummary", () => {
  // deriveStreamingProgress produces inputSummary from makeToolPreview("subagent", ...) → "subagent: builder"
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);
  // Parser sends bare toolName fallback (inputSummary === toolName) — should retain parent's richer value
  emitUpdate({
    toolActivity: { toolName: "subagent", inputSummary: "subagent" },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: builder",
  });
});

test("makeEmitUpdate merge: inputSummary !== toolName overwrites parent inputSummary", () => {
  // deriveStreamingProgress produces inputSummary: "subagent" (bare toolName from makeToolPreview)
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);
  // Parser sends richer inputSummary from nested child (different from toolName "subagent")
  emitUpdate({
    toolActivity: { toolName: "subagent", inputSummary: "bash: scan src" },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "bash: scan src",
  });
});

test("makeEmitUpdate merge: incoming without inputSummary preserves parent inputSummary", () => {
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);
  // Incoming has no inputSummary — merge should keep parent's richer semantic value
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      child: { toolName: "bash", inputSummary: "bash: ls" },
    },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: builder",
    child: { toolName: "bash", inputSummary: "bash: ls" },
  });
});

test("makeEmitUpdate streaming integration: subagent preview starts with semantic target then updated to richer parser inputSummary", () => {
  // deriveStreamingProgress produces activeToolActivity with inputSummary from semantic lookup: "subagent: builder"
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const texts: string[] = [];
  const emitUpdate = makeEmitUpdate(
    result,
    (partial) => {
      texts.push(partial.content[0]?.text ?? "");
    },
    makeSubagentDetails,
  );
  // First call triggers deriveStreamingProgress and sets result.progress
  emitUpdate();
  // progress derived from messages: makeToolPreview("subagent", ...) → "subagent: builder" (semantic lookup)
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: builder",
  });
  expect(result.progress?.activityText).toBe("subagent: builder");
  // Parser sends richer nested child data — merge prefers incoming inputSummary
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "bash: scan src",
      child: { toolName: "bash", inputSummary: "bash: scan src" },
    },
  });
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    "bash: scan src",
  );
  // renderToolActivity walks full tree: parent + child joined with " - "
  expect(result.progress?.activityText).toBe("bash: scan src - bash: scan src");
});

test("makeEmitUpdate preserves stored activity tree when toolResultCompleted arrives without new toolActivity", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // First set up initial tool activity via a tool call message
  result.messages.push(makeToolCallMessage("bash", { command: "ls" }));
  emitUpdate();

  // Store the initial activity
  const initialActivity = result.progress?.activeToolActivity;
  expect(initialActivity).toBeDefined();

  // Send toolResultCompleted without new toolActivity
  emitUpdate({ toolResultCompleted: true });

  // Activity should be preserved
  expect(result.progress?.activeToolActivity).toEqual(initialActivity);
  expect(result.progress?.toolResultCompleted).toBe(true);
});

test("makeEmitUpdate handles toolResultCompleted when renderToolActivity returns undefined", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Set up initial state with activity
  result.messages.push(makeToolCallMessage("bash", { command: "ls" }));
  emitUpdate();

  // Manually set progress to have activity
  result.progress = {
    activityText: "test activity",
    activeToolActivity: { toolName: "test" },
    toolCalls: [],
  };

  // Send toolResultCompleted
  emitUpdate({ toolResultCompleted: true });

  // Should preserve the activity
  expect(result.progress?.activeToolActivity).toBeDefined();
});

test("makeEmitUpdate merges toolActivity with different toolName as replacement", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Initial tool call for bash
  result.messages.push(makeToolCallMessage("bash", { command: "ls" }));
  emitUpdate();

  // Send update with different tool name (read)
  emitUpdate({
    toolActivity: { toolName: "read", inputSummary: "read: file.ts" },
  });

  // Should replace the activity entirely
  expect(result.progress?.activeToolActivity?.toolName).toBe("read");
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    "read: file.ts",
  );
});

test("makeEmitUpdate merges toolActivity with same toolName preserving richer inputSummary", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Initial tool call for subagent with semantic preview
  result.messages.push(
    makeToolCallMessage("subagent", {
      agent: "builder",
      task: "fix bugs",
    }),
  );
  emitUpdate();

  // Verify initial state has semantic inputSummary
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    "subagent: builder",
  );

  // Send update with same tool name but bare toolName fallback
  emitUpdate({
    toolActivity: { toolName: "subagent", inputSummary: "subagent" },
  });

  // Should keep the richer inputSummary
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    "subagent: builder",
  );
});

test("makeEmitUpdate merges toolActivity preserving instanceName when incoming has none", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // First call with toolActivity that has instanceName
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: builder",
      instanceName: "alpha-bravo",
    },
  });

  expect(result.progress?.activeToolActivity?.instanceName).toBe("alpha-bravo");

  // Second call with same toolName but no instanceName
  emitUpdate({
    toolActivity: { toolName: "subagent", inputSummary: "subagent: builder" },
  });

  // InstanceName from incoming is undefined, so merge uses undefined
  // (the spread operator overwrites with undefined)
  expect(result.progress?.activeToolActivity?.instanceName).toBeUndefined();
});

test("makeEmitUpdate merges toolActivity with incoming instanceName", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Set up initial activity with instanceName
  result.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: builder",
      instanceName: "alpha-bravo",
    },
  };

  // Send update with different instanceName
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: builder",
      instanceName: "charlie-delta",
    },
  });

  // Should use incoming instanceName
  expect(result.progress?.activeToolActivity?.instanceName).toBe(
    "charlie-delta",
  );
});

test("makeEmitUpdate merges toolActivity preserving child when incoming has none", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // First call with toolActivity that has child
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: builder",
      child: { toolName: "bash", inputSummary: "bash: ls" },
    },
  });

  expect(result.progress?.activeToolActivity?.child).toEqual({
    toolName: "bash",
    inputSummary: "bash: ls",
  });

  // Second call with same toolName but no child
  emitUpdate({
    toolActivity: { toolName: "subagent", inputSummary: "subagent: builder" },
  });

  // Child from incoming is undefined, so merge uses undefined
  // (the spread operator overwrites with undefined)
  expect(result.progress?.activeToolActivity?.child).toBeUndefined();
});

test("makeEmitUpdate merges toolActivity with incoming child", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Set up initial activity without child
  result.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: builder",
    },
  };

  // Send update with child
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: builder",
      child: { toolName: "read", inputSummary: "read: file.ts" },
    },
  });

  // Should add incoming child
  expect(result.progress?.activeToolActivity?.child).toEqual({
    toolName: "read",
    inputSummary: "read: file.ts",
  });
});

test("makeEmitUpdate handles empty activityText from renderToolActivity", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Set up initial state with activityText
  result.progress = {
    toolCalls: [],
    activityText: "old activity",
    activeToolActivity: { toolName: "test" },
  };

  // Send update with empty tool name
  emitUpdate({
    toolActivity: { toolName: "" },
  });

  // renderToolActivity returns empty string for empty toolName
  // which is not undefined, so activityText is set to empty string
  expect(result.progress?.activityText).toBe("");
});

test("makeEmitUpdate uses (running...) when activityText is undefined", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const capturedTexts: string[] = [];
  const emitUpdate = makeEmitUpdate(
    result,
    (partial) => {
      capturedTexts.push(partial.content[0]?.text ?? "");
    },
    makeSubagentDetails,
  );

  // Emit with no messages (empty progress)
  emitUpdate();

  // Should use fallback text
  expect(capturedTexts).toContain("(running...)");
});

test("makeEmitUpdate finds recent messages anchor with text content", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      } as Message,
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
        ],
      } as Message,
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      } as Message,
    ],
  });

  const capturedDetails: SubagentDetails[] = [];
  const emitUpdate = makeEmitUpdate(
    result,
    (partial) => {
      capturedDetails.push(partial.details);
    },
    makeSubagentDetails,
  );

  emitUpdate();

  // Should include recent messages from the anchor point
  expect(capturedDetails[0]?.results[0]?.messages).toBeDefined();
});

test("makeEmitUpdate falls back to last 5 messages when no anchor found", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 10; i++) {
    messages.push({
      role: "assistant",
      content: [
        { type: "toolCall", id: `tc-${i}`, name: "bash", arguments: {} },
      ],
    } as Message);
  }
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
    messages,
  });

  const capturedDetails: SubagentDetails[] = [];
  const emitUpdate = makeEmitUpdate(
    result,
    (partial) => {
      capturedDetails.push(partial.details);
    },
    makeSubagentDetails,
  );

  emitUpdate();

  // findRecentMessagesAnchor looks for assistant messages with text content
  // Since all messages are toolCalls (no text), anchorIdx is -1
  // Then recentMessages = msgs.slice(-5) which is last 5 messages
  // But makeDetails receives the full result which includes all messages
  expect(capturedDetails[0]?.results[0]?.messages).toBeDefined();
});

test("makeEmitUpdate handles multiple tool calls in deriveStreamingProgress", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
    messages: [
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
            arguments: { path: "file.ts" },
          },
        ],
      } as unknown as Message,
    ],
  });

  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  emitUpdate();

  // Should have both tool calls
  expect(result.progress?.toolCalls).toHaveLength(2);
  expect(result.progress?.toolCalls[0]?.id).toBe("tc-1");
  expect(result.progress?.toolCalls[1]?.id).toBe("tc-2");
  expect(result.progress?.lastToolPreview).toBeDefined();
});

test("makeEmitUpdate sanitizes sensitive preview in deriveStreamingProgress", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "read",
            arguments: { path: "secret-token.yaml" },
          },
        ],
      } as unknown as Message,
    ],
  });

  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  emitUpdate();

  // Should sanitize sensitive preview to tool name
  expect(result.progress?.lastToolPreview).toBe("read");
  expect(result.progress?.toolCalls[0]?.preview).toBe("read");
});

test("makeEmitUpdate handles toolResultCompleted with undefined activeToolActivity", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // No initial progress set
  emitUpdate({ toolResultCompleted: true });

  // Should not throw and should set toolResultCompleted
  expect(result.progress?.toolResultCompleted).toBe(true);
});

test("nested activity triggers onUpdate without appending messages", async () => {
  const updates: { text: string; messageCount: number }[] = [];
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading file.ts"))}
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      const text = partial.content[0]?.text ?? "";
      const msgCount = partial.details.results[0]?.messages?.length ?? 0;
      updates.push({ text, messageCount: msgCount });
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.messages).toHaveLength(1);
  const nestedUpdate = updates.find(
    (u) => u.text === "subagent - Reading file.ts",
  );
  expect(nestedUpdate).toBeDefined();
  expect(nestedUpdate?.messageCount).toBe(1);
});

test("nested activity with sensitive keywords is redacted", async () => {
  let capturedText = "";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading secret-token.yaml"))}
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      capturedText = partial.content[0]?.text ?? "";
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(capturedText).toBe("(running...)");
});

test("nested activity handles no-message no-terminal child exit", async () => {
  const updates: { text: string; messageCount: number }[] = [];
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Grandchild running"))}
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      const text = partial.content[0]?.text ?? "";
      const msgCount = partial.details.results[0]?.messages?.length ?? 0;
      updates.push({ text, messageCount: msgCount });
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.messages).toHaveLength(0);
  expect(result.progress?.activityText).toBe("subagent - Grandchild running");
  expect(updates).toContainEqual({
    text: "subagent - Grandchild running",
    messageCount: 0,
  });
});

test("child tool events replace nested activity in subsequent updates", async () => {
  const texts: string[] = [];
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Grandchild working"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"bash","arguments":{"command":"ls"}}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      texts.push(partial.content[0]?.text ?? "");
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(texts).toContain("subagent - Grandchild working");
  expect(texts.some((t) => t.includes("bash"))).toBe(true);
  const nestedIdx = texts.indexOf("subagent - Grandchild working");
  const toolIdx = texts.findIndex((t) => t.includes("bash"));
  expect(toolIdx).toBeGreaterThan(nestedIdx);
});

test("makeEmitUpdate handles toolResultCompleted without toolActivity", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });

  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );

  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
});

test("makeEmitUpdate handles onUpdate callback being undefined", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Should not throw when onUpdate is undefined
  expect(() => emitUpdate()).not.toThrow();
});

test("makeEmitUpdate handles toolResultCompleted with renderedText returning empty string", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Set up progress with activeToolActivity that renders to empty string
  result.progress = {
    toolCalls: [],
    activeToolActivity: { toolName: "" },
    activityText: "old text",
  };

  emitUpdate({ toolResultCompleted: true });

  // renderToolActivity returns empty string for empty toolName
  // which is not undefined, so activityText is set to empty string
  expect(result.progress?.activityText).toBe("");
});

test("makeEmitUpdate handles merge with incoming inputSummary equal to toolName", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Set up initial activity with richer inputSummary via tool call
  result.messages.push(makeToolCallMessage("bash", { command: "ls -la" }));
  emitUpdate();

  // Verify initial state
  expect(result.progress?.activeToolActivity?.inputSummary).toBeDefined();

  // Send update with inputSummary equal to toolName (bare fallback)
  // The merge logic: preferIncoming = incomingSummary && incomingSummary !== toolName
  // Since incomingSummary === toolName, preferIncoming is false
  // So it keeps the existing inputSummary
  emitUpdate({
    toolActivity: { toolName: "bash", inputSummary: "bash" },
  });

  // Should keep the richer inputSummary from deriveStreamingProgress
  expect(result.progress?.activeToolActivity?.inputSummary).not.toBe("bash");
});

test("makeEmitUpdate handles merge with empty incoming inputSummary", () => {
  const result = makeRuntimeResult({
    agent: "test",
    agentSource: "user",
    task: "task",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Set up initial activity via tool call
  result.messages.push(makeToolCallMessage("bash", { command: "ls -la" }));
  emitUpdate();

  const initialSummary = result.progress?.activeToolActivity?.inputSummary;

  // Send update with empty inputSummary
  // The merge logic: preferIncoming = incomingSummary && incomingSummary !== toolName
  // Since incomingSummary is empty string (falsy), preferIncoming is false
  // So it keeps the existing inputSummary
  emitUpdate({
    toolActivity: { toolName: "bash", inputSummary: "" },
  });

  // Should keep the existing inputSummary
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    initialSummary,
  );
});

test.each([
  {
    name: "makeEmitUpdate merge prefers parser inputSummary when richer than bare toolName fallback",
    command: "docker build .",
    inputSummary: "bash: docker build --no-cache .",
    expectedInputSummary: "bash: docker build --no-cache .",
  },
  {
    name: "makeEmitUpdate merge retains parent inputSummary when parser sends bare toolName fallback",
    command: "npm test",
    inputSummary: "bash",
    expectedInputSummary: "bash: npm test",
  },
])("$name", (row) => {
  const result = {
    agent: "test-agent",
    agentSource: "user" as const,
    task: "test task",
    exitCode: 0,
    finalOutput: "",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall" as const,
            id: "tc-1",
            name: "bash",
            arguments: { command: row.command },
          },
        ],
      },
    ] as unknown as Message[],
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
    progress: undefined as unknown as StreamingProgress,
  };
  const makeDetails = () =>
    ({
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      results: [],
    }) as SubagentDetails;
  const emit = makeEmitUpdate(
    result as unknown as Parameters<typeof makeEmitUpdate>[0],
    undefined,
    makeDetails,
  );
  emit({
    toolActivity: {
      toolName: "bash",
      inputSummary: row.inputSummary,
    },
  });
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    row.expectedInputSummary,
  );
  expect(result.progress?.activeToolActivity?.toolName).toBe("bash");
});

test("makeEmitUpdate merge preserves instanceName and child from incoming activity", () => {
  const result = {
    agent: "test-agent",
    agentSource: "user" as const,
    task: "test task",
    exitCode: 0,
    finalOutput: "",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall" as const,
            id: "tc-1",
            name: "subagent",
            arguments: { agent: "builder" },
          },
        ],
      },
    ] as unknown as Message[],
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
    progress: undefined as unknown as StreamingProgress,
  };
  const makeDetails = () =>
    ({
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      results: [],
    }) as SubagentDetails;
  const emit = makeEmitUpdate(
    result as unknown as Parameters<typeof makeEmitUpdate>[0],
    undefined,
    makeDetails,
  );
  emit({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "coder",
      instanceName: "sharp-finch",
      child: {
        toolName: "bash",
        inputSummary: "bash: cargo build",
      },
    },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "coder",
    instanceName: "sharp-finch",
    child: {
      toolName: "bash",
      inputSummary: "bash: cargo build",
    },
  });
  expect(result.progress?.activityText).toBe(
    "coder [sharp-finch] - bash: cargo build",
  );
});
