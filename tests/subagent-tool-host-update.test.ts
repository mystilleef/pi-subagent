import { expect, test } from "bun:test";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { listRunJobs } from "../src/orchestration/run-registry.js";
import type { SubagentDetails } from "../src/shared/types.js";
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

test.each([
  {
    scenario: "three identical tool calls",
    line: BASH_LS_TOOL_CALL,
    repeats: 3,
    fragment: "ls",
  },
  {
    scenario: "two identical tool calls",
    line: BASH_LS_TOOL_CALL,
    repeats: 2,
    fragment: "ls",
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
      return `${contentText}|${activityText}|${toolCallIds}|${exitCode}|${stopReason}`;
    }),
  );
  expect(uniqueFingerprints.size).toBe(hostUpdates.length);
  expect(listRunJobs()).toHaveLength(0);
});
