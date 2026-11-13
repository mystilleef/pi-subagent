import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { resetRunRegistry } from "../src/orchestration/run-registry.js";
import { queryInstanceUsage } from "../src/orchestration/usage-ledger.js";
import {
  getProgressState,
  resetProgressStore,
} from "../src/progress/progress.js";
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
  progressRenderBarrier,
  requestIdOf,
  runTool,
  setupFakePi,
  setupHooks,
  shellQuote,
  waitForSentMessage,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

afterEach(() => {
  resetProgressStore();
  resetRunRegistry();
});

const SUBAGENT_CALL_LINE = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name: "subagent",
        id: "sub-native-1",
        arguments: { agent: "build", task: "compile" },
      },
    ],
  },
});

const NESTED_FINAL_LINE = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
  },
});

test("tool_execution_update from subagent tool surfaces grandchild preview in parent store", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const sentinel = path.join(cwd, "continue");
  const toolUpdateLine = makeSubagentToolUpdateLine(
    "bash: make build",
    "swift-otter",
  );
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(SUBAGENT_CALL_LINE)}
printf '%s\n' ${shellQuote(toolUpdateLine)}
until [ -f ${shellQuote(sentinel)} ]; do sleep 0.02; done
printf '%s\n' ${shellQuote(NESTED_FINAL_LINE)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const progress = progressRenderBarrier(makeBareCtx(cwd));
  await runTool(tool, { agent: "hang", task: "native nested" }, progress.ctx);
  await waitForSentMessage(sentMessages);
  const requestId = requestIdOf(sentMessages);
  await progress.when(
    () => getProgressState(requestId)?.activeToolActivity?.child !== undefined,
    "grandchild preview surfaced via tool_execution_update",
  );
  const state = getProgressState(requestId);
  expect(state?.activeToolActivity?.toolName).toBe("subagent");
  expect(state?.activeToolActivity?.inputSummary).toBe("subagent: build");
  expect(state?.activeToolActivity?.instanceName).toBe("swift-otter");
  expect(state?.activeToolActivity?.child?.inputSummary).toBe(
    "bash: make build",
  );
  expect(state?.lastToolPreview).toContain("bash: make build");
  await writeFile(sentinel, "continue");
  await waitForSentMessageCount(sentMessages, 2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("tool_execution_update for a non-subagent tool updates parent activity", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const sentinel = path.join(cwd, "continue");
  const bashUpdateLine = makeSubagentToolUpdateLine(
    "bash: ls src",
    "swift-otter",
    "bash",
  );
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(SUBAGENT_CALL_LINE)}
printf '%s\n' ${shellQuote(bashUpdateLine)}
until [ -f ${shellQuote(sentinel)} ]; do sleep 0.02; done
printf '%s\n' ${shellQuote(NESTED_FINAL_LINE)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const progress = progressRenderBarrier(makeBareCtx(cwd));
  await runTool(tool, { agent: "hang", task: "native filter" }, progress.ctx);
  await waitForSentMessage(sentMessages);
  const requestId = requestIdOf(sentMessages);
  await progress.when(
    () =>
      getProgressState(requestId)?.lastToolPreview?.includes("bash: ls src") ===
      true,
    "non-subagent update surfaces in parent activity",
  );
  const state = getProgressState(requestId);
  expect(state?.activeToolActivity).toBeDefined();
  expect(state?.lastToolPreview).toContain("bash: ls src");
  await writeFile(sentinel, "continue");
  await waitForSentMessageCount(sentMessages, 2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("orchestrated path preserves nested activity across fallback child status updates", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading config.ts"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(
    tool,
    { agent: "hang", task: "preserve nested" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.toolCount).toBeGreaterThanOrEqual(1);
});

test("orchestrated path: fresh child tool call supersedes preserved nested activity", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Scanning files"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-fresh","arguments":{"command":"cat file.ts"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(
    tool,
    { agent: "hang", task: "fresh tool wins" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.toolCount).toBeGreaterThanOrEqual(1);
});

test("orchestrated path: terminal progress clears preserved nested activity", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading config.ts"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: completed"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(
    tool,
    { agent: "hang", task: "terminal clears" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.lastToolPreview).toBeUndefined();
});

test("patchProgressFromDetails: tool_result_end does not overwrite nested activity preview", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const sentinel = path.join(cwd, "continue");
  const subagentCallLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "subagent",
          id: "sub-nested-1",
          arguments: { agent: "build", task: "compile" },
        },
      ],
    },
  });
  const nestedLine = makeSubagentToolUpdateLine("bash: make build");
  const toolResultEndLine = JSON.stringify({
    type: "tool_result_end",
    message: { role: "toolResult", content: [] },
  });
  const finalLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    },
  });
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(subagentCallLine)}
printf '%s\n' ${shellQuote(nestedLine)}
printf '%s\n' ${shellQuote(toolResultEndLine)}
until [ -f ${shellQuote(sentinel)} ]; do sleep 0.02; done
printf '%s\n' ${shellQuote(finalLine)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const progress = progressRenderBarrier(makeBareCtx(cwd));
  await runTool(tool, { agent: "hang", task: "nested preview" }, progress.ctx);
  await waitForSentMessage(sentMessages);
  const requestId = requestIdOf(sentMessages);
  await progress.when(() => {
    const state = getProgressState(requestId);
    // `toolResultCompleted` flips once, on the nested `tool_result_end`, so the
    // wait cannot settle on the earlier preview the nested update overwrites.
    return (
      state?.toolResultCompleted === true &&
      state.lastToolPreview === "subagent: build"
    );
  }, "parent preview preserved through tool_result_end");
  expect(getProgressState(requestId)?.lastToolPreview).toBe("subagent: build");
  expect(getProgressState(requestId)?.activeToolActivity).toBeDefined();
  expect(
    getProgressState(requestId)?.activeToolActivity?.instanceName,
  ).toBeUndefined();
  await writeFile(sentinel, "continue");
  await waitForSentMessageCount(sentMessages, 2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("patchProgressFromDetails: parent preview shows friendly instance label after nested tool result pop", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const sentinel = path.join(cwd, "continue");
  const subagentCallLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "subagent",
          id: "sub-nested-label",
          arguments: { agent: "build", task: "compile" },
        },
      ],
    },
  });
  const nestedLine = makeSubagentToolUpdateLine(
    "bash: make build",
    "able-falcon",
  );
  const toolResultEndLine = JSON.stringify({
    type: "tool_result_end",
    message: { role: "toolResult", content: [] },
  });
  const finalLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    },
  });
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(subagentCallLine)}
printf '%s\n' ${shellQuote(nestedLine)}
printf '%s\n' ${shellQuote(toolResultEndLine)}
until [ -f ${shellQuote(sentinel)} ]; do sleep 0.02; done
printf '%s\n' ${shellQuote(finalLine)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const progress = progressRenderBarrier(makeBareCtx(cwd));
  await runTool(tool, { agent: "hang", task: "nested label" }, progress.ctx);
  await waitForSentMessage(sentMessages);
  const requestId = requestIdOf(sentMessages);
  await progress.when(
    () =>
      getProgressState(requestId)?.lastToolPreview ===
      "subagent: build [able-falcon]",
    "parent preview shows friendly instance label",
  );
  expect(getProgressState(requestId)?.lastToolPreview).toBe(
    "subagent: build [able-falcon]",
  );
  expect(getProgressState(requestId)?.activeToolActivity).toBeDefined();
  expect(getProgressState(requestId)?.activeToolActivity?.instanceName).toBe(
    "able-falcon",
  );
  await writeFile(sentinel, "continue");
  await waitForSentMessageCount(sentMessages, 2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("orchestrated path: result detail shape remains compatible with preserved nested activity", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading config.ts"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.01}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(
    tool,
    { agent: "hang", task: "shape compat" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(resultDetails.results[0]).toBeDefined();
  expect(resultDetails.results[0]?.exitCode).toBe(0);
  expect(resultDetails.results[0]?.usage).toBeDefined();
  expect(typeof resultDetails.results[0]?.usage?.input).toBe("number");
  expect(typeof resultDetails.results[0]?.usage?.output).toBe("number");
});

test("parallel sibling and grandchild snapshots attach by id independently of single visible ToolActivity slot", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const sentinel = path.join(cwd, "continue");

  const makeChildUpdate = (
    agent: string,
    instanceName: string,
    activitySummary: string,
    usageTree: UsageInstanceNode,
  ) =>
    JSON.stringify({
      type: "tool_execution_update",
      toolName: "subagent",
      partialResult: {
        content: [{ type: "text", text: activitySummary }],
        details: {
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: [
            {
              agent,
              instanceName,
              progress: {
                toolCalls: [],
                lastToolPreview: activitySummary,
                activityText: activitySummary,
                activeToolActivity: {
                  toolName: "bash",
                  inputSummary: activitySummary,
                },
              },
            },
          ],
          usageTree,
        },
      },
    });

  const sibAInitial: UsageInstanceNode = {
    id: "sib-a",
    agent: "explorer",
    instanceName: "able-fox",
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
  const sibB: UsageInstanceNode = {
    id: "sib-b",
    agent: "worker",
    instanceName: "bold-owl",
    ordinal: 1,
    startedAt: 1_100,
    status: "running",
    usage: {
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.02,
      turns: 1,
    },
    children: [],
  };
  const sibAWithGrandchild: UsageInstanceNode = {
    ...sibAInitial,
    status: "success",
    durationMs: 250,
    usage: {
      input: 30,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.03,
      turns: 2,
    },
    children: [
      {
        id: "gc-of-a",
        agent: "reader",
        instanceName: "calm-jay",
        ordinal: 1,
        startedAt: 1_200,
        status: "success",
        durationMs: 80,
        usage: {
          input: 5,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.005,
          turns: 1,
        },
        children: [],
      },
    ],
  };

  const u1 = makeChildUpdate("explorer", "able-fox", "bash: find", sibAInitial);
  const u2 = makeChildUpdate("worker", "bold-owl", "bash: build", sibB);
  const u3 = makeChildUpdate(
    "explorer",
    "able-fox",
    "bash: done",
    sibAWithGrandchild,
  );
  // Repeat u3 to confirm idempotent wholesale replacement.
  const u4 = u3;

  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\\n' ${shellQuote(SUBAGENT_CALL_LINE)}
printf '%s\\n' ${shellQuote(u1)}
printf '%s\\n' ${shellQuote(u2)}
printf '%s\\n' ${shellQuote(u3)}
printf '%s\\n' ${shellQuote(u4)}
until [ -f ${shellQuote(sentinel)} ]; do sleep 0.02; done
printf '%s\\n' ${shellQuote(NESTED_FINAL_LINE)}
${emitAgentEnd()}
exit 0
`,
  );

  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const progress = progressRenderBarrier(makeBareCtx(cwd));
  await runTool(
    tool,
    { agent: "hang", task: "parallel siblings" },
    progress.ctx,
  );
  await waitForSentMessage(sentMessages);
  const requestId = requestIdOf(sentMessages);

  await progress.when(() => {
    const query = queryInstanceUsage(requestId);
    const sibA = query?.instance.children.find((c) => c.id === "sib-a");
    return (
      query?.instance.children.length === 2 &&
      sibA?.status === "success" &&
      sibA?.children.length === 1
    );
  }, "both parallel siblings and grandchild retained in ledger");

  // Single visible activity slot reflects latest update while ledger keeps both siblings.
  const state = getProgressState(requestId);
  expect(state?.activeToolActivity?.instanceName).toBe("able-fox");

  const liveQuery = queryInstanceUsage(requestId);
  expect(liveQuery?.instance.children.map((c) => c.id)).toEqual([
    "sib-a",
    "sib-b",
  ]);
  expect(liveQuery?.rollup.instances).toBe(4);
  expect(liveQuery?.rollup.usage.input).toBe(55);

  await writeFile(sentinel, "continue");
  await waitForSentMessageCount(sentMessages, 2);

  // Terminal transition reconciles still-running sib-b to cancelled.
  const finalQuery = queryInstanceUsage(requestId);
  expect(finalQuery?.instance.status).toBe("success");
  const finalSibB = finalQuery?.instance.children.find((c) => c.id === "sib-b");
  expect(finalSibB?.status).toBe("cancelled");
  expect(finalQuery?.rollup.statuses).toEqual({
    running: 0,
    success: 3,
    error: 0,
    cancelled: 1,
  });
});

test("rejects invalid boundary usageTrees and tolerates snapshot-less subagent calls without affecting self usage or progress", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();

  const validChild: UsageInstanceNode = {
    id: "valid-child",
    agent: "worker",
    instanceName: "able-wren",
    ordinal: 1,
    startedAt: 1_000,
    status: "success",
    durationMs: 50,
    usage: {
      input: 12,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      turns: 1,
    },
    children: [],
  };

  const makeUpdateWithRawTree = (usageTree: unknown) =>
    JSON.stringify({
      type: "tool_execution_update",
      toolName: "subagent",
      partialResult: {
        content: [{ type: "text", text: "running" }],
        details: {
          results: [
            {
              agent: "worker",
              instanceName: "bad-wren",
              progress: {
                activeToolActivity: {
                  toolName: "bash",
                  inputSummary: "bash: pwd",
                },
              },
            },
          ],
          usageTree,
        },
      },
    });

  const snapshotLessUpdate = makeSubagentToolUpdateLine(
    "bash: snapshotless",
    "plain-owl",
  );
  const snapshotLessToolResult = JSON.stringify({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "sub-plain",
      toolName: "subagent",
      content: [{ type: "text", text: "ok" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "worker",
            instanceName: "plain-owl",
            agentSource: "user",
            task: "plain",
            exitCode: 0,
            finalOutput: "ok",
            stderr: "",
            usage: {
              input: 99,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.5,
              contextTokens: 0,
              turns: 1,
            },
          },
        ],
      },
      isError: false,
      timestamp: 2_000,
    },
  });

  const badMalformed = makeUpdateWithRawTree("not-a-tree");
  const badSensitive = makeUpdateWithRawTree({
    ...validChild,
    id: "bad-sensitive",
    prompt: "top-secret-prompt",
  });
  const badDuplicateNested = makeUpdateWithRawTree({
    ...validChild,
    id: "dup-parent",
    children: [{ ...validChild, id: "dup-parent" }],
  });
  const badDuplicateSibling = makeUpdateWithRawTree({
    ...validChild,
    id: "bad-wrapper",
    children: [{ ...validChild, id: "valid-child" }],
  });
  const badSessionId = makeUpdateWithRawTree({
    ...validChild,
    id: "bad-session",
    sessionId: "leak-session",
  });
  const goodUpdate = makeUpdateWithRawTree(validChild);

  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\\n' ${shellQuote(SUBAGENT_CALL_LINE)}
printf '%s\\n' ${shellQuote(goodUpdate)}
printf '%s\\n' ${shellQuote(badMalformed)}
printf '%s\\n' ${shellQuote(badSensitive)}
printf '%s\\n' ${shellQuote(badDuplicateNested)}
printf '%s\\n' ${shellQuote(badDuplicateSibling)}
printf '%s\\n' ${shellQuote(badSessionId)}
printf '%s\\n' ${shellQuote(snapshotLessUpdate)}
printf '%s\\n' ${shellQuote(snapshotLessToolResult)}
printf '%s\\n' ${shellQuote(NESTED_FINAL_LINE)}
${emitAgentEnd()}
exit 0
`,
  );

  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "isolation" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);

  const requestId = requestIdOf(sentMessages);
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");

  const finalDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(finalDetails.results[0]?.usage.input).toBe(1);
  const tree = finalDetails.usageTree;
  expect(tree?.children).toHaveLength(1);
  expect(tree?.children[0]?.id).toBe("valid-child");
  expect(tree?.children[0]?.usage.input).toBe(12);
});
