import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { resetRunRegistry } from "../src/orchestration/run-registry.js";
import {
  getProgressState,
  resetProgressStore,
} from "../src/progress/progress.js";
import type { SubagentDetails } from "../src/shared/types.js";
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
