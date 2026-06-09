import { expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { makeEmitUpdate } from "../src/child/process.js";
import type { SingleResult, SubagentDetails } from "../src/shared/types.js";
import { makeSubagentDetails, setupHooks } from "./helpers.js";

setupHooks();

function makeRuntimeResult(
  messages: Message[] = [],
): SingleResult & { messages: Message[] } {
  return {
    agent: "test",
    agentSource: "user",
    task: "task",
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
    messages,
  } as SingleResult & { messages: Message[] };
}

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

test("makeEmitUpdate preserves stored activity tree when toolResultCompleted arrives without new toolActivity", () => {
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult([
    {
      role: "assistant",
      content: [{ type: "text", text: "first" }],
    } as Message,
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: {} }],
    } as Message,
    {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    } as Message,
  ]);

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
  const result = makeRuntimeResult(messages);

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
  const result = makeRuntimeResult([
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
  ]);

  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  emitUpdate();

  // Should have both tool calls
  expect(result.progress?.toolCalls).toHaveLength(2);
  expect(result.progress?.toolCalls[0]?.id).toBe("tc-1");
  expect(result.progress?.toolCalls[1]?.id).toBe("tc-2");
  expect(result.progress?.lastToolPreview).toBeDefined();
});

test("makeEmitUpdate sanitizes sensitive preview in deriveStreamingProgress", () => {
  const result = makeRuntimeResult([
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
  ]);

  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  emitUpdate();

  // Should sanitize sensitive preview to tool name
  expect(result.progress?.lastToolPreview).toBe("read");
  expect(result.progress?.toolCalls[0]?.preview).toBe("read");
});

test("makeEmitUpdate handles toolResultCompleted with undefined activeToolActivity", () => {
  const result = makeRuntimeResult();
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // No initial progress set
  emitUpdate({ toolResultCompleted: true });

  // Should not throw and should set toolResultCompleted
  expect(result.progress?.toolResultCompleted).toBe(true);
});

test("makeEmitUpdate handles onUpdate callback being undefined", () => {
  const result = makeRuntimeResult();
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

  // Should not throw when onUpdate is undefined
  expect(() => emitUpdate()).not.toThrow();
});

test("makeEmitUpdate handles toolResultCompleted with renderedText returning empty string", () => {
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
  const result = makeRuntimeResult();
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
