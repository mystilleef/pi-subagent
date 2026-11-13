import { expect, test } from "bun:test";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { listRunJobs } from "../src/orchestration/run-registry.js";
import type {
  SubagentDetails,
  UsageInstanceNode,
} from "../src/shared/types.js";
import type { SendMessageArg } from "./helpers.js";
import {
  emitAgentEnd,
  getSubagentTool,
  installFakePi,
  makeBareCtx,
  makeSubagentToolUpdateLine,
  runTool,
  setupFakePi,
  setupHooks,
  setupTest,
  shellQuote,
  waitForSentMessage,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

test("host onUpdate callback is forwarded to lifecycle for running jobs", async () => {
  const sentMessages: SendMessageArg[] = [];
  const hostOnUpdate: AgentToolUpdateCallback<SubagentDetails> = () => {};
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(result.content).toBeDefined();
  expect(result.details).toBeDefined();
  expect(result.details.renderedByMessage).toBe(true);
});

test("host onUpdate callback type is compatible with AgentToolUpdateCallback", async () => {
  const hostOnUpdate: AgentToolUpdateCallback<SubagentDetails> = (
    partial: AgentToolResult<SubagentDetails>,
  ) => {
    expect(partial.content).toBeDefined();
    expect(Array.isArray(partial.content)).toBe(true);
    for (const contentBlock of partial.content) {
      expect(contentBlock.type).toBe("text");
      if (contentBlock.type === "text") {
        expect(typeof contentBlock.text).toBe("string");
      }
    }
    expect(partial.details).toBeDefined();
    expect(partial.details.mode).toBe("single");
    expect(partial.details.agentScope).toBeDefined();
    expect(Array.isArray(partial.details.results)).toBe(true);
  };
  expect(typeof hostOnUpdate).toBe("function");
});

test("tool executes successfully without onUpdate callback", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "test" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(result.content).toBeDefined();
  expect(result.content[0]?.type).toBe("text");
  if (result.content[0]?.type === "text") {
    expect(result.content[0].text).toBe("done");
  }
  expect(result.details).toBeDefined();
  expect(result.details.mode).toBe("single");
  expect(result.details.renderedByMessage).toBe(true);
});

test("live partial updates are forwarded to host callback with correct shape", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(partialUpdates.length).toBeGreaterThan(0);
  for (const partial of partialUpdates) {
    expect(partial.content).toBeDefined();
    expect(Array.isArray(partial.content)).toBe(true);
    expect(partial.content.length).toBeGreaterThan(0);
    expect(partial.content[0]?.type).toBe("text");
    if (partial.content[0]?.type === "text") {
      expect(typeof partial.content[0].text).toBe("string");
      expect(partial.content[0].text.length).toBeGreaterThan(0);
    }
    expect(partial.details).toBeDefined();
    expect(partial.details.mode).toBe("single");
    expect(partial.details.agentScope).toBeDefined();
    expect(Array.isArray(partial.details.results)).toBe(true);
    expect(partial.details.renderedByMessage).toBeUndefined();
  }
  expect(result.details.renderedByMessage).toBe(true);
});

test("hostOnUpdate is called when fingerprint changes between updates", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  const line1 = makeSubagentToolUpdateLine("first update", "inst-1");
  const line2 = makeSubagentToolUpdateLine("second update", "inst-1");
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\\n' ${shellQuote(line1)}
printf '%s\\n' ${shellQuote(line2)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(partialUpdates.length).toBeGreaterThanOrEqual(2);
  const texts = partialUpdates.map(
    (u) => (u.content[0] as { type: "text"; text: string }).text,
  );
  expect(new Set(texts).size).toBeGreaterThan(1);
});

test("partial updates contain meaningful activity text from child progress", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"echo hello"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(partialUpdates.length).toBeGreaterThan(0);
  const hasToolPreview = partialUpdates.some((partial) => {
    const text =
      partial.content[0]?.type === "text" ? partial.content[0].text : "";
    return text.includes("bash") || text.includes("echo");
  });
  const hasRunningFallback = partialUpdates.some((partial) => {
    const text =
      partial.content[0]?.type === "text" ? partial.content[0].text : "";
    return text === "(running...)";
  });
  expect(hasToolPreview || hasRunningFallback).toBe(true);
});

test("partial updates preserve progress state patching and progress card renders", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const statusCalls: { key: string; value: string | undefined }[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    {
      cwd,
      hasUI: false,
      ui: {
        setStatus: (key: string, value: string | undefined) =>
          statusCalls.push({ key, value }),
      },
    } as unknown as ExtensionContext,
  );
  expect(partialUpdates.length).toBeGreaterThan(0);
  const progressRenders = statusCalls.filter((call) =>
    call.key.startsWith("subagent-progress:"),
  );
  expect(progressRenders.length).toBeGreaterThan(0);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
});

test("failure path with callback does not throw and returns structured error", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"error occurred"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}},"errorMessage":"test error"}}'
${emitAgentEnd()}
exit 1
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(result.content).toBeDefined();
  expect(result.details).toBeDefined();
  expect(result.details.renderedByMessage).toBe(true);
  const latestResult = result.details.results[0];
  expect(latestResult?.exitCode).toBe(1);
});

test("cancellation path with callback does not throw and returns structured cancellation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const controller = new AbortController();
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"working"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
sleep 5
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const executePromise = tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    controller.signal,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  await waitForSentMessage(sentMessages);
  controller.abort();
  const result = await executePromise;
  expect(result.content).toBeDefined();
  expect(result.details).toBeDefined();
  expect(result.details.renderedByMessage).toBe(true);
});

const BASH_LS_TOOL_CALL = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name: "bash",
        id: "tc-1",
        arguments: { command: "ls" },
      },
    ],
  },
});

function makeSubagentSnapshotUpdateLine(
  preview: string,
  usageTree: UsageInstanceNode,
  instanceName = "keen-fox",
): string {
  return JSON.stringify({
    type: "tool_execution_update",
    toolName: "subagent",
    partialResult: {
      content: [{ type: "text", text: preview }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "worker",
            instanceName,
            agentSource: "user",
            task: "",
            exitCode: 0,
            finalOutput: "",
            stderr: "",
            usage: {
              input: usageTree.usage.input,
              output: usageTree.usage.output,
              cacheRead: usageTree.usage.cacheRead,
              cacheWrite: usageTree.usage.cacheWrite,
              cost: usageTree.usage.cost,
              contextTokens: 0,
              turns: usageTree.usage.turns,
            },
            progress: {
              toolCalls: [],
              lastToolPreview: preview,
              activityText: preview,
              activeToolActivity: { toolName: "tool", inputSummary: preview },
            },
          },
        ],
        usageTree,
      },
    },
  });
}

test.each([
  {
    scenario: "three identical tool activity updates",
    line: makeSubagentToolUpdateLine("bash: ls src"),
    repeats: 3,
    fragment: "ls src",
  },
  {
    scenario: "two identical tool activity updates",
    line: makeSubagentToolUpdateLine("bash: ls src"),
    repeats: 2,
    fragment: "ls src",
  },
])(
  "hostOnUpdate coalesces $scenario into fewer updates than events",
  async ({ line, repeats, fragment }) => {
    const repeated = Array.from(
      { length: repeats },
      () => `printf '%s\\n' ${shellQuote(line)}`,
    ).join("\n");
    const { tool, cwd } = await setupTest({
      piScript: `#!/bin/sh
${repeated}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
    });
    const updates: AgentToolResult<SubagentDetails>[] = [];
    process.env.PI_SUBAGENT_DEPTH = "1";
    await tool.execute(
      "test-tool-call",
      { agent: "hang", task: "dedup" },
      undefined,
      (partial) => updates.push(partial),
      makeBareCtx(cwd),
    );
    const matching = updates.filter((update) => {
      const first = update.content[0];
      return first?.type === "text" && first.text.includes(fragment);
    });
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.length).toBeLessThan(repeats);
    expect(listRunJobs()).toHaveLength(0);
  },
);

test("repeated assistant message_end turns increment usageTree turns and reach hostOnUpdate", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' ${shellQuote(BASH_LS_TOOL_CALL)}
printf '%s\\n' ${shellQuote(BASH_LS_TOOL_CALL)}
${emitAgentEnd()}
exit 0
`,
  });
  const updates: AgentToolResult<SubagentDetails>[] = [];
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "turn-updates" },
    undefined,
    (partial) => updates.push(partial),
    makeBareCtx(cwd),
  );
  expect(updates).toHaveLength(2);
  expect(updates[0]?.details.usageTree?.usage.turns).toBe(1);
  expect(updates[1]?.details.usageTree?.usage.turns).toBe(2);
});

test("distinct progress events reach callback despite deduplication guard", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"tc-2","arguments":{"path":"file.txt"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  const hasLsTool = partialUpdates.some((partial) => {
    const text =
      partial.content[0]?.type === "text" ? partial.content[0].text : "";
    return text.includes("ls");
  });
  const hasReadTool = partialUpdates.some((partial) => {
    const text =
      partial.content[0]?.type === "text" ? partial.content[0].text : "";
    return text.includes("read") || text.includes("file.txt");
  });
  expect(hasLsTool).toBe(true);
  expect(hasReadTool).toBe(true);
});

test("empty agent_end messages do not emit synthetic hostOnUpdate", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${emitAgentEnd([])}
exit 0
`,
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "empty" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(partialUpdates).toHaveLength(0);
});

test("hostOnUpdate deduplicates identical payloads via fingerprint", async () => {
  const sentMessages: SendMessageArg[] = [];
  const hostUpdates: unknown[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const onUpdate: AgentToolUpdateCallback<SubagentDetails> = (payload) => {
    hostUpdates.push(payload);
  };
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "dedup task" },
    undefined,
    onUpdate,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(hostUpdates.length).toBeGreaterThanOrEqual(1);
  const uniqueFingerprints = new Set(
    hostUpdates.map((u) => {
      const p = u as {
        content: { type: string; text?: string }[];
        details: SubagentDetails;
      };
      const contentText = p.content[0]?.text ?? "";
      const latestResult = p.details.results[0];
      const activityText = latestResult?.progress?.activityText ?? "";
      const toolCallIds = [
        ...new Set(
          latestResult?.progress?.toolCalls?.map((tc: { id: string }) => tc.id),
        ),
      ]
        .sort()
        .join(",");
      const exitCode = latestResult?.exitCode ?? 0;
      const stopReason = latestResult?.stopReason ?? "";
      const usageTreeKey = JSON.stringify(p.details.usageTree ?? null);
      return `${contentText}|${activityText}|${toolCallIds}|${exitCode}|${stopReason}|${usageTreeKey}`;
    }),
  );
  expect(uniqueFingerprints.size).toBe(hostUpdates.length);
  expect(listRunJobs()).toHaveLength(0);
});

test("hostOnUpdate delivers snapshot-only usageTree changes and deduplicates identical snapshots", async () => {
  const sentMessages: SendMessageArg[] = [];
  const hostUpdates: AgentToolResult<SubagentDetails>[] = [];
  const snap1: UsageInstanceNode = {
    id: "grandchild-1",
    agent: "worker",
    instanceName: "keen-fox",
    ordinal: 1,
    startedAt: 1_000,
    status: "running",
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
  const snap2: UsageInstanceNode = {
    ...snap1,
    usage: {
      input: 40,
      output: 15,
      cacheRead: 2,
      cacheWrite: 0,
      cost: 0.05,
      turns: 2,
    },
  };
  const line1 = makeSubagentSnapshotUpdateLine("bash: ls", snap1);
  const line2Duplicate = makeSubagentSnapshotUpdateLine("bash: ls", snap1);
  const line3SnapshotOnly = makeSubagentSnapshotUpdateLine("bash: ls", snap2);

  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' ${shellQuote(line1)}
printf '%s\\n' ${shellQuote(line2Duplicate)}
printf '%s\\n' ${shellQuote(line3SnapshotOnly)}
${emitAgentEnd()}
exit 0
`,
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "snapshot-only change" },
    undefined,
    (partial) => hostUpdates.push(partial),
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);

  expect(hostUpdates).toHaveLength(2);
  expect(hostUpdates[0]?.details.usageTree?.children[0]?.usage.input).toBe(10);
  expect(hostUpdates[1]?.details.usageTree?.children[0]?.usage.input).toBe(40);
});

test("later current snapshot repairs missed intermediate updates via wholesale replacement", async () => {
  const sentMessages: SendMessageArg[] = [];
  const hostUpdates: AgentToolResult<SubagentDetails>[] = [];
  const initialSnap: UsageInstanceNode = {
    id: "grandchild-1",
    agent: "worker",
    instanceName: "keen-fox",
    ordinal: 1,
    startedAt: 1_000,
    status: "running",
    usage: {
      input: 5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      turns: 1,
    },
    children: [],
  };
  // Intermediate update with input: 20 was missed; later current snapshot has input: 55 + nested grandchild.
  const currentTerminalSnap: UsageInstanceNode = {
    ...initialSnap,
    status: "success",
    durationMs: 300,
    usage: {
      input: 55,
      output: 25,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.09,
      turns: 3,
    },
    children: [
      {
        id: "great-grandchild-1",
        agent: "reader",
        instanceName: "warm-lark",
        ordinal: 1,
        startedAt: 1_100,
        status: "success",
        durationMs: 120,
        usage: {
          input: 12,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.02,
          turns: 1,
        },
        children: [],
      },
    ],
  };

  const updateLine = makeSubagentSnapshotUpdateLine(
    "bash: step 1",
    initialSnap,
  );
  const terminalMessageLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-sub-1",
      toolName: "subagent",
      content: [{ type: "text", text: "ok" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "worker",
            instanceName: "keen-fox",
            agentSource: "user",
            task: "work",
            exitCode: 0,
            finalOutput: "ok",
            stderr: "",
            usage: {
              input: 55,
              output: 25,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.09,
              contextTokens: 0,
              turns: 3,
            },
          },
        ],
        usageTree: currentTerminalSnap,
      },
      isError: false,
      timestamp: 2_000,
    },
  });

  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' ${shellQuote(updateLine)}
printf '%s\\n' ${shellQuote(terminalMessageLine)}
${emitAgentEnd()}
exit 0
`,
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "repair missed update" },
    undefined,
    (partial) => hostUpdates.push(partial),
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);

  expect(hostUpdates).toHaveLength(2);
  const deliveredChild = hostUpdates[1]?.details.usageTree?.children[0];
  expect(deliveredChild?.status).toBe("success");
  expect(deliveredChild?.usage.input).toBe(55);
  expect(deliveredChild?.children).toHaveLength(1);
  expect(deliveredChild?.children[0]?.id).toBe("great-grandchild-1");

  const finalTree = (result.details as SubagentDetails).usageTree;
  expect(finalTree?.children[0]?.usage.input).toBe(55);
  expect(finalTree?.children[0]?.children[0]?.id).toBe("great-grandchild-1");
});
