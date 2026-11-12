import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import { listRunJobs } from "../src/orchestration/run-registry.js";
import { getProgressState } from "../src/progress/progress.js";
import type { SubagentDetails } from "../src/shared/types.js";
import type { SendMessageArg } from "./helpers.js";
import {
  CAPTURE_PI_ARGS_SH,
  emitAgentEnd,
  emitMessageEnd,
  flagValues,
  getSubagentTool,
  installFakePi,
  makeAssistantMessage,
  makeBareCtx,
  readCapturedArgs,
  requestIdOf,
  runTool,
  setupFakePi,
  setupHooks,
  setupTest,
  shellQuote,
  waitForRunJobsCleared,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

test("positive-depth subagent tool exposes debug details for stderr exit", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' 'boom from stderr' >&2
exit 7
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "nested stderr", debug: true },
    makeBareCtx(cwd),
  );
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain("boom from stderr");
  expect(sentMessages).toHaveLength(2);
  const requestId = requestIdOf(sentMessages);
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.results[0]?.exitCode).toBe(7);
  expect(directDetails.results[0]?.stderr).toContain("boom from stderr");
  expect(directDetails.results[0]?.messages).toHaveLength(0);
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("boom from stderr");
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool accepts omitted task", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
exit 0
`,
  });
  await runTool(tool, { agent: "hang" }, makeBareCtx(cwd));
  await waitForRunJobsCleared();
  const args = await readCapturedArgs(cwd);
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(args.at(-1)).toBe(
    "Run according to your system prompt. If no explicit task was provided, use the default context described there.",
  );
  expect(args.at(-1)).not.toContain("Task:");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
  expect(promptText).toBe("Test agent prompt.");
});

test("subagent tool injects current result format", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
exit 0
`,
  });
  await runTool(tool, { agent: "hang", task: "ship it" }, makeBareCtx(cwd));
  await waitForRunJobsCleared();
  const args = await readCapturedArgs(cwd);
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(args.at(-1)).toBe("Task: ship it");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  expect(args.join("\n")).not.toContain("Changed:");
  expect(args.join("\n")).not.toContain("Cause:");
  const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
  expect(promptText).toBe("Test agent prompt.");
});

test("subagent tool with custom tools allows child to call complete", async () => {
  const sentMessages: SendMessageArg[] = [];
  const asstMessage = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-custom-complete",
          name: "complete",
          arguments: { outcome: "custom tools completed" },
        },
      ],
    },
  });
  const toolResultMsg = JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-custom-complete",
      details: { outcome: "custom tools completed" },
    },
  });
  const agentEndMsg = JSON.stringify({
    type: "agent_end",
    messages: [],
  });
  const { agentDir, tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' ${shellQuote(asstMessage)}
printf '%s\\n' ${shellQuote(toolResultMsg)}
printf '%s\\n' ${shellQuote(agentEndMsg)}
exit 0
`,
  });
  await writeFile(
    path.join(agentDir, "agents", "custom-tools-complete.md"),
    `---
name: custom-tools-complete
description: Custom tools complete
tools: bash, read
---
Custom prompt.`,
  );
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "custom-tools-complete", task: "custom tools task" },
    makeBareCtx(cwd),
  );
  await waitForRunJobsCleared();
  const args = await readCapturedArgs(cwd);
  expect(args.join(" ")).toContain("--tools bash,read,complete");
  expect(args.at(-1)).toBe("Task: custom tools task");
  expect((result.details as SubagentDetails).results[0]?.outcome).toBe(
    "custom tools completed",
  );
  expect((result.content[0] as TextContent).text).toBe("(no output)");
});

test("subagent tool sends result card when fake pi exits normally", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "normal" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
});

test("subagent tool sends result card when fake pi emits agent_end but stays alive", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
case "$*" in
  *agent-end-no-exit*) sleep 10 ;;
esac
exit 0
`,
  });
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  await runTool(
    tool,
    { agent: "hang", task: "agent-end-no-exit", debug: true },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool hides agent_end_timeout metadata outside debug", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: completed after timeout"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd([])}
sleep 10
`,
  });
  await runTool(
    tool,
    { agent: "hang", task: "agent-end-no-exit" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(sentMessages.at(-1)?.content).toBe("Outcome: completed after timeout");
  expect(details.results[0]?.finalOutput).toBe(
    "Outcome: completed after timeout",
  );
  expect(details.results[0]?.messages).toBeUndefined();
  expect(details.results[0]?.termination).toBeUndefined();
  expect(details.results[0]?.stderr).toBe("");
  const requestId = requestIdOf(sentMessages);
  expect(getProgressState(requestId)?.status).toBe("success");
  expect(getProgressState(requestId)?.finalOutput).toBe(
    "outcome: completed after timeout",
  );
});

test("subagent tool falls back to agent_end messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"from agent_end"}],"usage":{"input":2,"output":3,"totalTokens":5,"cost":{"total":0.01}}}]}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("from agent_end");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.usage.input).toBe(2);
});

test("subagent tool keeps long semantic parent fields without truncation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const longOutcome = `shipped ${"x".repeat(2_001)}`;
  const finalOutput = `${longOutcome}\nVerification: bun test\nNext: none`;
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } },
    },
  });
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  const content = sentMessages.at(-1)?.content as string;
  expect(content).toBe(`${longOutcome}\nVerification: bun test\nNext: none`);
  expect(content).not.toContain(
    "[truncated: full output available in details]",
  );
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.finalOutput).toBe(finalOutput);
});

test("subagent tool returns semantic parent text while preserving full details", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const finalOutput =
    "Migration applied to 3 tables.\nAll tests pass.\nNo rollback needed.\nExtra line.";
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
      model: "gpt-4",
      usage: { input: 3, output: 4, totalTokens: 7, cost: { total: 0.002 } },
    },
  });
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe(
    "Migration applied to 3 tables.\nAll tests pass.\nNo rollback needed.\nExtra line.",
  );
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.finalOutput).toBe(finalOutput);
  expect(details.results[0]?.usage.input).toBe(3);
  expect(details.results[0]?.usage.output).toBe(4);
  expect(details.results[0]?.durationMs).toEqual(expect.any(Number));
  expect(details.results[0]?.stderr).toBe("");
  expect(details.results[0]?.errorMessage).toBeUndefined();
  expect(details.results[0]?.messages).toBeUndefined();
});

test("subagent tool failure sends error result via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const finalOutput =
    "Outcome: failed at verify\nCause: parsed cause\nVerification: parsed verification\nNext: parsed next";
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
    },
  });
  const toolResultEnd = JSON.stringify({
    type: "message_end",
    message: { role: "toolResult", content: [], isError: true },
  });
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' ${shellQuote(toolResultEnd)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  const failureStartDetails = sentMessages[0]?.details as {
    instanceName?: string;
    requestId?: string;
  };
  const failureDetails = sentMessages.at(-1)?.details as SubagentDetails;
  const requestId = requestIdOf(sentMessages);
  expect(failureDetails.results[0]?.instanceName).toBe(
    failureStartDetails.instanceName,
  );
  expect(getProgressState(requestId)?.status).toBe("error");
});

test("subagent tool errorMessage failure sends error result via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "looks successful" }],
      stopReason: "stop",
      errorMessage: "recorded child failure",
    },
  });
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "0";
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain(
    "recorded child failure",
  );
});

test("subagent tool leaves context window unknown for unknown metadata", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"provider":"unknown-provider","model":"unknown-model","usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.001}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.usage.contextWindowTokens).toBeUndefined();
});

test("subagent tool accumulates toolCount in progress state", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"2","arguments":{"path":"/tmp/x"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
  expect(getProgressState(requestId)?.toolCount).toBe(2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("subagent tool preserves stopReason error after agent_end timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const { binDir, cwd } = await setupFakePi();
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "looks successful" }],
      stopReason: "error",
    },
  });
  await installFakePi(
    binDir,
    `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' ${shellQuote(messageEnd)}
${emitAgentEnd()}
sleep 10 &
wait $!
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(
    tool,
    { agent: "hang", task: "timeout", debug: true },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(resultDetails.results[0]?.stopReason).toBe("error");
  expect(resultDetails.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool fails agent_end timeout with tool-only transcript", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
${emitAgentEnd()}
sleep 10 &
wait $!
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(
    tool,
    { agent: "hang", task: "timeout", debug: true },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const finalContent = sentMessages.at(-1)?.content;
  expect(finalContent).toStartWith("(failed) ");
  expect(finalContent).toContain("Agent failed:");
  expect(finalContent).not.toMatch(/\n\n/);
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(resultDetails.results[0]?.exitCode).toBe(1);
  expect(resultDetails.results[0]?.finalOutput).toBe("");
  expect(resultDetails.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool reports stderr failures via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' 'boom from stderr' >&2
exit 7
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "stderr" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("boom from stderr");
});

test("subagent tool debug hygiene: child messages stay in details only for debug result", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"SECRET_DEBUG"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"model":"gpt-4","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
printf '%s\n' 'STDERR_DEBUG' >&2
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  const normalDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(normalDetails.results[0]?.messages).toBeUndefined();
  expect(normalDetails.results[0]?.termination).toBeUndefined();
  expect(normalDetails.results[0]?.stderr).toBe("");
  expect(sentMessages.at(-1)?.content).toBe("Outcome: hello");
  expect(sentMessages.at(-1)?.content).not.toContain("SECRET_DEBUG");
  const sentMessages2: SendMessageArg[] = [];
  const tool2 = getSubagentTool({
    sendMessage: (msg) => sentMessages2.push(msg),
  });
  await runTool(
    tool2,
    { agent: "hang", task: "test", debug: true },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages2, 2);
  const debugWithoutEnv = sentMessages2.at(-1)?.details as SubagentDetails;
  expect(debugWithoutEnv.results[0]?.messages).toBeUndefined();
  expect(debugWithoutEnv.results[0]?.termination).toBeUndefined();
  expect(debugWithoutEnv.results[0]?.stderr).toBe("");
  expect(JSON.stringify(debugWithoutEnv)).not.toContain("SECRET_DEBUG");
  const sentMessages3: SendMessageArg[] = [];
  const tool3 = getSubagentTool({
    sendMessage: (msg) => sentMessages3.push(msg),
  });
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  await runTool(
    tool3,
    { agent: "hang", task: "test", debug: true },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages3, 2);
  const debugDetails = sentMessages3.at(-1)?.details as SubagentDetails;
  expect(debugDetails.results[0]?.messages).toHaveLength(2);
  expect(debugDetails.results[0]?.termination).toBeUndefined();
  expect(debugDetails.results[0]?.stderr).toContain("STDERR_DEBUG");
  expect(JSON.stringify(debugDetails.results[0]?.messages)).not.toContain(
    "SECRET_DEBUG",
  );
  expect(JSON.stringify(debugDetails.results[0]?.messages)).toContain(
    "[redacted]",
  );
  expect(sentMessages3.at(-1)?.content).not.toContain("SECRET_DEBUG");
});

test("subagent tool logs unknown event diagnostics only for authorized debug", async () => {
  const originalStderrWrite = process.stderr.write;
  const diagnostics: string[] = [];
  (
    process.stderr as unknown as {
      write: (chunk: string | Uint8Array) => boolean;
    }
  ).write = (chunk) => {
    diagnostics.push(chunk.toString());
    return true;
  };
  try {
    const { tool, cwd } = await setupTest({
      piScript: `#!/bin/sh
printf '%s\n' '{"type":"future_event","payload":1}'
printf '%s\n' '{ not json }'
printf '\n'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: diagnostics"}]}}'
${emitAgentEnd([])}
exit 0
`,
    });
    await runTool(
      tool,
      { agent: "hang", task: "test", debug: true },
      makeBareCtx(cwd),
    );
    await waitForRunJobsCleared();
    expect(diagnostics.join("")).not.toContain("[pi-subagent:unknown-event]");
    process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
    await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
    await waitForRunJobsCleared();
    expect(diagnostics.join("")).not.toContain("[pi-subagent:unknown-event]");
    await runTool(
      tool,
      { agent: "hang", task: "test", debug: true },
      makeBareCtx(cwd),
    );
    await waitForRunJobsCleared();
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  const output = diagnostics.join("");
  expect(output).toContain(
    '[pi-subagent:unknown-event] unknown: {"type":"future_event","payload":1}',
  );
  expect(output).toContain(
    "[pi-subagent:unknown-event] malformed: { not json }",
  );
  expect(output).toContain("[pi-subagent:unknown-event] blank");
});

test("final success result uses renderedByMessage to avoid duplicate rendering", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { tool, cwd } = await setupTest({
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
    expect(partial.details.renderedByMessage).toBeUndefined();
  }
  expect(result.details.renderedByMessage).toBe(true);
  const resultMessage = sentMessages.find(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessage).toBeDefined();
  const resultMessageDetails = resultMessage?.details as SubagentDetails;
  expect(resultMessageDetails.renderedByMessage).toBeUndefined();
});

test("subagent tool successful run with complete tool preserves outcome in details without finalOutput mutation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const asstMessage = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Task completed successfully." },
        {
          type: "toolCall",
          id: "tc-complete-1",
          name: "complete",
          arguments: { outcome: "Successfully done" },
        },
      ],
    },
  });
  const toolResultMsg = JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-complete-1",
      details: { outcome: "Successfully done" },
    },
  });
  const agentEndMsg = JSON.stringify({
    type: "agent_end",
    messages: [],
  });

  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' ${shellQuote(asstMessage)}
printf '%s\\n' ${shellQuote(toolResultMsg)}
printf '%s\\n' ${shellQuote(agentEndMsg)}
exit 0
`,
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "test outcome" },
    makeBareCtx(cwd),
  );

  // Parent details should expose results[0].outcome
  expect(result.details.results[0]?.outcome).toBe("Successfully done");

  // finalOutput contains only assistant text and remains unchanged
  expect(result.details.results[0]?.finalOutput).toBe(
    "Task completed successfully.",
  );

  // Result content does not synthesize the outcome text
  expect((result.content[0] as TextContent).text).toBe(
    "Task completed successfully.",
  );
});

test("subagent tool with tool-only complete preserves outcome with empty finalOutput", async () => {
  const sentMessages: SendMessageArg[] = [];
  const asstMessage = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-complete-2",
          name: "complete",
          arguments: { outcome: "Only completed without text" },
        },
      ],
    },
  });
  const toolResultMsg = JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-complete-2",
      details: { outcome: "Only completed without text" },
    },
  });
  const agentEndMsg = JSON.stringify({
    type: "agent_end",
    messages: [],
  });

  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' ${shellQuote(asstMessage)}
printf '%s\\n' ${shellQuote(toolResultMsg)}
printf '%s\\n' ${shellQuote(agentEndMsg)}
exit 0
`,
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "tool-only outcome" },
    makeBareCtx(cwd),
  );

  expect(result.details.results[0]?.outcome).toBe(
    "Only completed without text",
  );
  expect(result.details.results[0]?.finalOutput).toBe("");
  expect((result.content[0] as TextContent).text).toBe("(no output)");
});

test("subagent tool failure keeps existing content/error semantics with no outcome field", async () => {
  const sentMessages: SendMessageArg[] = [];
  const asstMessage = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Failed with errors." },
        {
          type: "toolCall",
          id: "tc-complete-3",
          name: "complete",
          arguments: { outcome: "Failed outcome but it will be ignored" },
        },
      ],
    },
  });
  const toolResultMsg = JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-complete-3",
      isError: true,
      details: { outcome: "Failed outcome but it will be ignored" },
    },
  });
  const agentEndMsg = JSON.stringify({
    type: "agent_end",
    messages: [],
  });

  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' ${shellQuote(asstMessage)}
printf '%s\\n' ${shellQuote(toolResultMsg)}
printf '%s\\n' ${shellQuote(agentEndMsg)}
exit 1
`,
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "failure outcome" },
    makeBareCtx(cwd),
  );

  // In case of non-zero exit code or semantic failure, outcome should be undefined
  expect(result.details.results[0]?.outcome).toBeUndefined();
  expect(result.details.results[0]?.finalOutput).toBe("Failed with errors.");
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain("Failed with errors.");
});
