import { afterEach, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import {
  listRunJobs,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import { emitCompletionAlert } from "../src/orchestration/subagent-orchestrator.js";
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  resetProgressStore,
} from "../src/progress/progress.js";
import type { SubagentDetails } from "../src/shared/types.js";
import {
  getSubagentTool,
  type SendMessageArg,
  setupFakePi,
  setupHooks,
  setupTest,
  shellQuote,
  waitFor,
  waitForRunJobsCleared,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

test("subagent tool returns job-started immediately without waiting for child", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toMatch(
    /^Subagent hang [a-z]+-[a-z]+ started \(job: /,
  );
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(listRunJobs().length).toBeGreaterThan(0);
  const job = listRunJobs()[0];
  if (job) job.controller.abort("cleanup");
  await waitForRunJobsCleared();
});

test("subagent tool registers independent job per invocation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const ctx = { cwd, hasUI: false } as unknown as ExtensionContext;
  const [r1, r2] = await Promise.all([
    tool.execute(
      "id-1",
      { agent: "hang", task: "task one" },
      undefined,
      undefined,
      ctx,
    ),
    tool.execute(
      "id-2",
      { agent: "hang", task: "task two" },
      undefined,
      undefined,
      ctx,
    ),
  ]);
  expect((r1.content[0] as TextContent).text).toContain("started");
  expect((r2.content[0] as TextContent).text).toContain("started");
  const jobs = listRunJobs();
  expect(jobs.length).toBe(2);
  const ids = new Set(jobs.map((j) => j.requestId));
  expect(ids.size).toBe(2);
  for (const job of jobs) job.controller.abort("cleanup");
  await waitForRunJobsCleared();
});

test("subagent tool result appears in sent messages after child exits", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  const startDetails = sentMessages[0]?.details as { instanceName?: string };
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(sentMessages.at(-1)?.content).toBe("done");
  expect(resultDetails.results[0]?.instanceName).toBe(
    startDetails.instanceName,
  );
});

test("subagent tool finishes when child exits with inherited open streams", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "orphaned-streams" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.termination).toBeUndefined();
});

test("subagent tool accepts omitted task", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForRunJobsCleared();
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
  expect(argsText).not.toContain("Task:");
});

test("subagent tool injects current result format", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "ship it" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForRunJobsCleared();
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
  expect(argsText).toContain("Task: ship it");
  expect(argsText).toContain(SUBAGENT_RESULT_CONTRACT);
  expect(argsText).not.toContain("Changed:");
  expect(argsText).not.toContain("Cause:");
});

test("subagent tool sends result card when fake pi exits normally", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "normal" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
});

test("subagent tool sends result card when fake pi emits agent_end but stays alive", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
case "$*" in
  *agent-end-no-exit*) sleep 10 ;;
esac
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "agent-end-no-exit", debug: true },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool hides agent_end_timeout metadata outside debug", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "agent-end-no-exit" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(sentMessages.at(-1)?.content).toBe("done");
  expect(details.results[0]?.messages).toBeUndefined();
  expect(details.results[0]?.termination).toBeUndefined();
  expect(details.results[0]?.stderr).toBe("");
});

test("subagent tool fails agent_end timeout with empty transcript", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "agent-end-no-output", debug: true },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("(failed)");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.exitCode).toBe(1);
  expect(details.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool falls back to agent_end messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"from agent_end"}],"usage":{"input":2,"output":3,"totalTokens":5,"cost":{"total":0.01}}}]}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
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
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
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
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
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
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' ${shellQuote(toolResultEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  const failureStartDetails = sentMessages[0]?.details as {
    instanceName?: string;
    requestId?: string;
  };
  const failureDetails = sentMessages.at(-1)?.details as SubagentDetails;
  const requestId = failureStartDetails.requestId;
  if (!requestId) throw new Error("requestId missing");
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
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "0";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain(
    "recorded child failure",
  );
});

test("subagent tool spawn error sends error result via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await Bun.$`rm -f ${path.join(binDir, "pi")}`;
  process.env.PATH = binDir;
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error progress state from spawn failure");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toBeTruthy();
});

test("subagent tool handles unknown agent synchronously", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const result = await tool.execute(
    "test-tool-call",
    { agent: "non-existent", task: "whatever" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toContain(
    'Unknown agent: "non-existent"',
  );
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool respects agentScope", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-agent.md"),
    `---
name: project-agent
description: Project agent
---
System prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const resultUser = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "user" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  expect((resultUser.content[0] as TextContent).text).toContain(
    'Unknown agent: "project-agent"',
  );
  const resultBoth = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "both" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      ui: { confirm: async () => true },
    } as unknown as ExtensionContext,
  );
  expect((resultBoth.content[0] as TextContent).text).toContain("started");
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
});

test("subagent tool requires confirmation for project agents with UI", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-agent.md"),
    `---
name: project-agent
description: Project agent
---
System prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  let confirmed = false;
  const fakeUI = {
    confirm: async () => {
      confirmed = true;
      return false;
    },
  };
  const result = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "both" },
    undefined,
    undefined,
    { cwd, hasUI: true, ui: fakeUI } as unknown as ExtensionContext,
  );
  expect(confirmed).toBe(true);
  expect((result.content[0] as TextContent).text).toContain("Canceled");
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool abort cancels the background job", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const controller = new AbortController();
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    controller.signal,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitFor(
    () => (sentMessages.length > 0 ? true : undefined),
    "progress message",
  );
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  controller.abort();
  await waitForRunJobsCleared();
  expect(getProgressState(requestId)?.status).toBe("cancelled");
});

test("subagent tool captures pi output including usage and model", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"provider":"openai","model":"gpt-4o-mini","usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.001}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("Outcome: hello");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.usage.input).toBe(10);
  expect(details.results[0]?.finalOutput).toBe("Outcome: hello");
  expect(details.results[0]?.messages).toBeUndefined();
  expect(details.results[0]?.instanceName).toMatch(/^[a-z]+-[a-z]+$/);
  expect(details.results[0]?.usage.contextWindowTokens).toBe(128000);
  if (details.results[0]?.model !== "gpt-4o-mini")
    expect(details.results[0]?.model).toBe("thinking:off");
  const sentMessages2: SendMessageArg[] = [];
  const tool2 = getSubagentTool({
    sendMessage: (msg) => sentMessages2.push(msg),
  });
  await tool2.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages2, 2);
  const debugDetails = sentMessages2.at(-1)?.details as SubagentDetails;
  expect(debugDetails.results[0]?.messages).toHaveLength(1);
  expect(debugDetails.results[0]?.instanceName).toMatch(/^[a-z]+-[a-z]+$/);
});

test("subagent tool leaves context window unknown for unknown metadata", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"provider":"unknown-provider","model":"unknown-model","usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.001}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.usage.contextWindowTokens).toBeUndefined();
});

test("subagent tool accumulates toolCount in progress state", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"2","arguments":{"path":"/tmp/x"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.toolCount).toBe(2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("subagent tool preserves stopReason error after agent_end timeout", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "looks successful" }],
      stopReason: "error",
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
sleep 10 &
wait $!
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "timeout", debug: true },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state after stopReason timeout");
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(resultDetails.results[0]?.stopReason).toBe("error");
  expect(resultDetails.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool fails agent_end timeout with tool-only transcript", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"agent_end"}'
sleep 10 &
wait $!
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "timeout", debug: true },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state after missing output timeout");
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(resultDetails.results[0]?.exitCode).toBe(1);
  expect(resultDetails.results[0]?.finalOutput).toBe("");
  expect(resultDetails.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool reports depth limit synchronously via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "nested" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state from depth limit");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("depth");
});

test("subagent tool reports unknown skill via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();
  process.env.PI_SUBAGENT_DEPTH = "0";
  await writeFile(
    path.join(agentDir, "agents", "needs-skill.md"),
    `---
name: needs-skill
description: Needs a skill
skills: missing-skill
---
Prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "needs-skill", task: "skills" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state from unknown skill");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("missing-skill");
});

test("subagent tool reports stderr failures via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' 'boom from stderr' >&2
exit 7
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "stderr" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state from stderr");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("boom from stderr");
});

test("subagent tool debug hygiene: child messages stay in details only for debug result", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"SECRET_DEBUG"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"model":"gpt-4","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
printf '%s\n' 'STDERR_DEBUG' >&2
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
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
  await tool2.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages2, 2);
  const debugDetails = sentMessages2.at(-1)?.details as SubagentDetails;
  expect(debugDetails.results[0]?.messages).toHaveLength(2);
  expect(debugDetails.results[0]?.termination).toBeUndefined();
  expect(debugDetails.results[0]?.stderr).toContain("STDERR_DEBUG");
  expect(JSON.stringify(debugDetails.results[0]?.messages)).toContain(
    "SECRET_DEBUG",
  );
  expect(sentMessages2.at(-1)?.content).not.toContain("SECRET_DEBUG");
});

// --- emitCompletionAlert tests ---

function makeProgressState(overrides: {
  requestId?: string;
  agent?: string;
  task?: string;
  status?: string;
  durationMs?: number;
  instanceName?: string;
  finalOutput?: string;
  errorText?: string;
}) {
  const requestId = overrides.requestId ?? crypto.randomUUID();
  createProgressState(
    requestId,
    overrides.agent ?? "test-agent",
    overrides.task ?? "test task",
    overrides.instanceName ?? "adj-word",
  );
  if (overrides.status === "success" || overrides.finalOutput !== undefined) {
    finalizeProgressState(requestId, overrides.finalOutput ?? "task completed");
  }
  if (overrides.status === "error" || overrides.errorText !== undefined) {
    failProgressState(requestId, overrides.errorText ?? "something failed");
  }
  if (overrides.status === "cancelled") {
    cancelProgressState(requestId, "cancelled");
  }
  if (overrides.durationMs !== undefined) {
    const state = getProgressState(requestId);
    if (state) {
      (state as { durationMs?: number }).durationMs = overrides.durationMs;
    }
  }
  return getProgressState(requestId);
}

afterEach(() => {
  resetProgressStore();
  resetRunRegistry();
});

test("emitCompletionAlert emits bell on TTY", () => {
  const writeCalls: string[] = [];
  const origWrite = process.stdout.write;
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ) => {
      writeCalls.push(s);
      return true;
    };
    const state = makeProgressState({
      status: "success",
      finalOutput: "all tests pass",
    });
    emitCompletionAlert(state);
    expect(writeCalls).toContain("\x07");
  } finally {
    process.stdout.write = origWrite;
    if (origIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    }
  }
});

test("emitCompletionAlert skips on non-TTY", () => {
  const writeCalls: string[] = [];
  const origWrite = process.stdout.write;
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  });
  try {
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ) => {
      writeCalls.push(s);
      return true;
    };
    const state = makeProgressState({
      status: "success",
      finalOutput: "all tests pass",
    });
    emitCompletionAlert(state);
    expect(writeCalls).toEqual([]);
  } finally {
    process.stdout.write = origWrite;
    if (origIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    }
  }
});

test("emitCompletionAlert skips for cancelled jobs", () => {
  const writeCalls: string[] = [];
  const origWrite = process.stdout.write;
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ) => {
      writeCalls.push(s);
      return true;
    };
    const state = makeProgressState({ status: "cancelled" });
    emitCompletionAlert(state);
    expect(writeCalls).toEqual([]);
  } finally {
    process.stdout.write = origWrite;
    if (origIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    }
  }
});

test("emitCompletionAlert emits bell for error jobs", () => {
  const writeCalls: string[] = [];
  const origWrite = process.stdout.write;
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ) => {
      writeCalls.push(s);
      return true;
    };
    const state = makeProgressState({
      status: "error",
      errorText: "child process crashed",
    });
    emitCompletionAlert(state);
    expect(writeCalls).toContain("\x07");
  } finally {
    process.stdout.write = origWrite;
    if (origIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    }
  }
});

test("emitCompletionAlert skips absent state", () => {
  expect(() => emitCompletionAlert(undefined)).not.toThrow();
});
