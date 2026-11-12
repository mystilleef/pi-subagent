import { expect, spyOn, test } from "bun:test";
import { type FileHandle, mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import {
  cancelRunJob,
  listRunJobs,
} from "../src/orchestration/run-registry.js";
import { getProgressState } from "../src/progress/progress.js";
import type { SubagentDetails } from "../src/shared/types.js";
import type { SendMessageArg } from "./helpers.js";
import {
  CAPTURE_ARGS_PI_SCRIPT,
  CAPTURE_PI_ARGS_SH,
  emitAgentEnd,
  flagValues,
  getSubagentTool,
  installFakePi,
  makeBareCtx,
  modelFixture,
  progressRenderBarrier,
  readCapturedArgs,
  registryFixture,
  requestIdOf,
  runTool,
  setupFakePi,
  setupHooks,
  setupTest,
  shellQuote,
  waitForPath,
  waitForRunJobCount,
  waitForRunJobsCleared,
  waitForSentMessage,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

test("subagent tool result appears in sent messages after child exits", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
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

test("positive-depth subagent tool waits for success and returns completed result", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "nested" },
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toBe("done");
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages[1]?.customType).toBe("subagent-result");
  const startDetails = sentMessages[0]?.details as {
    instanceName?: string;
    requestId?: string;
  };
  const messageDetails = sentMessages[1]?.details as SubagentDetails;
  const directDetails = result.details as SubagentDetails;
  const requestId = requestIdOf(sentMessages);
  expect(sentMessages[1]?.content).toBe("done");
  expect(directDetails.renderedByMessage).toBe(true);
  expect(directDetails.results[0]?.finalOutput).toBe("done");
  expect(directDetails.results[0]?.stderr).toBe("");
  expect(directDetails.results[0]?.messages).toBeUndefined();
  expect(directDetails.results[0]?.instanceName).toBe(
    startDetails.instanceName,
  );
  expect(messageDetails.results[0]?.instanceName).toBe(
    startDetails.instanceName,
  );
  expect(messageDetails.results[0]?.finalOutput).toBe("done");
  expect(getProgressState(requestId)?.status).toBe("success");
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth concurrent subagent calls keep independent jobs and progress", async () => {
  const sentMessages: SendMessageArg[] = [];
  const originalRandom = Math.random;
  const randomValues = [0, 0, 0.5, 0.5];
  Math.random = () => randomValues.shift() ?? originalRandom();
  let releaseBarrier: (() => Promise<void>) | undefined;
  let releaseHandle: FileHandle | undefined;
  let released = false;
  try {
    const { binDir, cwd } = await setupFakePi();
    const startedOne = path.join(cwd, "started-one");
    const startedTwo = path.join(cwd, "started-two");
    // A named pipe keeps the child barrier event-driven: each child blocks in one
    // read on the pipe and the case releases it by writing a token per call, so
    // neither side polls a release file or waits out a fixed interval.
    const releasePipe = path.join(cwd, "release.pipe");
    await Bun.$`mkfifo ${releasePipe}`;
    await installFakePi(
      binDir,
      `#!/bin/sh
case "$*" in
  *"task one"*) text=one; marker=${shellQuote(startedOne)} ;;
  *"task two"*) text=two; marker=${shellQuote(startedTwo)} ;;
  *) printf '%s\n' "unexpected task: $*" >&2; exit 1 ;;
esac
: > "$marker"
read -r _ <> ${shellQuote(releasePipe)}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"'"$text"'"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
    );
    const tool = getSubagentTool({
      sendMessage: (msg) => sentMessages.push(msg),
    });
    process.env.PI_SUBAGENT_DEPTH = "1";
    const ctx = makeBareCtx(cwd);
    const calls = [
      tool.execute(
        "nested-1",
        { agent: "hang", task: "task one" },
        undefined,
        undefined,
        ctx,
      ),
      tool.execute(
        "nested-2",
        { agent: "hang", task: "task two" },
        undefined,
        undefined,
        ctx,
      ),
    ];
    // `r+` opens both ends without blocking, so release also settles a case
    // that fails before every child reaches the pipe, and the write end stays
    // open until every call settles: a pipe keeps the tokens it buffers only
    // while a descriptor references it, so closing before a child reads the
    // pipe would strand that child indefinitely.
    releaseBarrier = async () => {
      releaseHandle ??= await open(releasePipe, "r+");
      if (!released) {
        await releaseHandle.write("release\n".repeat(calls.length));
        released = true;
      }
      await Promise.allSettled(calls);
    };
    await waitForPath(startedOne, "first concurrent child started");
    await waitForPath(startedTwo, "second concurrent child started");
    await waitForRunJobCount(2);
    const runningJobs = listRunJobs();
    expect(new Set(runningJobs.map((job) => job.requestId)).size).toBe(2);
    expect(new Set(runningJobs.map((job) => job.instanceName)).size).toBe(2);
    await releaseBarrier();
    const results = await Promise.all(calls);
    const starts = sentMessages.filter(
      (msg) =>
        msg.customType === "subagent-progress" &&
        Boolean((msg.details as { requestId?: string } | undefined)?.requestId),
    );
    const terminals = sentMessages.filter(
      (msg) => msg.customType === "subagent-result",
    );
    const startIds = starts.map(
      (msg) => (msg.details as { requestId: string }).requestId,
    );
    const startInstances = starts.map(
      (msg) => (msg.details as { instanceName: string }).instanceName,
    );
    const directDetails = results.map(
      (result) => result.details as SubagentDetails,
    );
    const terminalDetails = terminals.map(
      (msg) => msg.details as SubagentDetails,
    );
    expect(starts).toHaveLength(2);
    expect(terminals).toHaveLength(2);
    expect(new Set(startIds).size).toBe(2);
    expect(new Set(startInstances).size).toBe(2);
    expect(
      results.map((result) => (result.content[0] as TextContent).text).sort(),
    ).toEqual(["one", "two"]);
    expect(terminals.map((msg) => msg.content).sort()).toEqual(["one", "two"]);
    expect(directDetails.every((details) => details.renderedByMessage)).toBe(
      true,
    );
    expect(
      directDetails.map((details) => details.results[0]?.instanceName).sort(),
    ).toEqual(startInstances.toSorted());
    expect(
      terminalDetails.map((details) => details.results[0]?.instanceName).sort(),
    ).toEqual(startInstances.toSorted());
    for (const [index, requestId] of startIds.entries()) {
      const state = getProgressState(requestId);
      expect(state?.status).toBe("success");
      expect(state?.instanceName).toBe(startInstances[index]);
    }
    expect(listRunJobs()).toHaveLength(0);
  } finally {
    Math.random = originalRandom;
    await releaseBarrier?.();
    await releaseHandle?.close();
  }
});

test("positive-depth subagent tool returns completed result for child failure", async () => {
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
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "nested failure" },
    makeBareCtx(cwd),
  );
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain(finalOutput);
  expect(resultText).toMatch(/\n\nOutcome: failed at verify/);
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages.at(-1)?.content).toBe(resultText);
  const startDetails = sentMessages[0]?.details as {
    instanceName?: string;
    requestId?: string;
  };
  const requestId = requestIdOf(sentMessages);
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.renderedByMessage).toBe(true);
  expect(directDetails.results[0]?.instanceName).toBe(
    startDetails.instanceName,
  );
  expect(directDetails.results[0]?.finalOutput).toBe(finalOutput);
  expect(directDetails.results[0]?.stderr).toBe("");
  expect(directDetails.results[0]?.messages).toBeUndefined();
  expect(directDetails.results[0]?.termination).toBeUndefined();
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth subagent tool returns completed result for setup failure", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();
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
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "needs-skill", task: "nested setup" },
    makeBareCtx(cwd),
  );
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain("missing-skill");
  expect(sentMessages).toHaveLength(2);
  const requestId = requestIdOf(sentMessages);
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.renderedByMessage).toBe(true);
  expect(directDetails.results[0]?.exitCode).toBe(1);
  expect(directDetails.results[0]?.stderr).toBe("");
  expect(directDetails.results[0]?.messages).toBeUndefined();
  expect(directDetails.results[0]?.termination).toBeUndefined();
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("missing-skill");
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth subagent tool cancels on host abort with debug termination", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
sleep 10 &
wait $!
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const controller = new AbortController();
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const progress = progressRenderBarrier(makeBareCtx(cwd));
  const promise = runTool(
    tool,
    { agent: "hang", task: "nested abort", debug: true },
    progress.ctx,
    controller.signal,
  );
  await waitForSentMessage(sentMessages);
  const requestId = requestIdOf(sentMessages);
  await progress.when(
    () => (getProgressState(requestId)?.inputTokens ?? 0) >= 1,
    "partial nested output",
  );
  controller.abort("host stop");
  const result = await promise;
  expect((result.content[0] as TextContent).text).toBe("Canceled");
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.results[0]?.messages).toHaveLength(1);
  expect(directDetails.results[0]?.termination?.cancelReason).toBe("host stop");
  expect(getProgressState(requestId)?.status).toBe("cancelled");
  expect(listRunJobs()).toHaveLength(0);
  const resultMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessages).toHaveLength(1);
  expect(resultMessages[0]?.content).toBe("Canceled");
});

test("positive-depth subagent tool cancels on registered job abort", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const promise = runTool(
    tool,
    { agent: "hang", task: "nested cancel", debug: true },
    makeBareCtx(cwd),
  );
  await waitForSentMessage(sentMessages);
  const requestId = requestIdOf(sentMessages);
  expect(cancelRunJob(requestId, "nested cancel")).toBe(true);
  const result = await promise;
  expect((result.content[0] as TextContent).text).toBe("Canceled");
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.results[0]?.termination?.cancelReason).toBe(
    "nested cancel",
  );
  expect(getProgressState(requestId)?.status).toBe("cancelled");
  expect(getProgressState(requestId)?.errorText).toContain("nested cancel");
  expect(listRunJobs()).toHaveLength(0);
  const resultMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessages).toHaveLength(1);
  expect(resultMessages[0]?.content).toBe("Canceled");
});

test("subagent tool spawn error sends error result via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await Bun.$`rm -f ${path.join(binDir, "pi")}`;
  process.env.PATH = binDir;
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toBeTruthy();
});

test("subagent tool handles unknown agent synchronously", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const result = await runTool(
    tool,
    { agent: "non-existent", task: "whatever" },
    makeBareCtx(cwd),
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
  const resultUser = await runTool(
    tool,
    { agent: "project-agent", task: "test", agentScope: "user" },
    makeBareCtx(cwd),
  );
  expect((resultUser.content[0] as TextContent).text).toContain(
    'Unknown agent: "project-agent"',
  );
  const resultBoth = await runTool(
    tool,
    { agent: "project-agent", task: "test", agentScope: "both" },
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
  const result = await runTool(
    tool,
    { agent: "project-agent", task: "test", agentScope: "both" },
    { cwd, hasUI: true, ui: fakeUI } as unknown as ExtensionContext,
  );
  expect(confirmed).toBe(true);
  expect((result.content[0] as TextContent).text).toContain("Canceled");
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
});

test("pre-aborted host signal cancels after valid agent discovery without side effects", async () => {
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
      return true;
    },
  };
  const controller = new AbortController();
  controller.abort("pre-aborted");
  const result = await runTool(
    tool,
    { agent: "project-agent", task: "test", agentScope: "both" },
    { cwd, hasUI: true, ui: fakeUI } as unknown as ExtensionContext,
    controller.signal,
  );
  expect(confirmed).toBe(false);
  expect((result.content[0] as TextContent).text).toBe("Canceled");
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
  expect(getProgressState("test-tool-call")).toBeUndefined();
  const details = result.details as SubagentDetails;
  expect(details.results).toHaveLength(0);
  expect(details.mode).toBe("single");
});

test("positive-depth subagent tool preserves scope confirmation and collision semantics", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();
  const userAgentsDir = path.join(agentDir, "agents");
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await mkdir(projectAgentsDir, { recursive: true });
  await writeFile(
    path.join(projectAgentsDir, "project-only.md"),
    `---
name: project-only
description: Project only
---
Project prompt`,
  );
  await writeFile(
    path.join(userAgentsDir, "same.md"),
    `---
name: same
description: User same
---
User prompt`,
  );
  await writeFile(
    path.join(projectAgentsDir, "same.md"),
    `---
name: same
description: Project same
extensions: []
---
Project prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const resultUser = await runTool(
    tool,
    { agent: "project-only", task: "test", agentScope: "user" },
    makeBareCtx(cwd),
  );
  expect((resultUser.content[0] as TextContent).text).toContain(
    'Unknown agent: "project-only"',
  );
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
  let confirmSawNoJob = false;
  const rejectingUI = {
    confirm: async () => {
      confirmSawNoJob = sentMessages.length === 0 && listRunJobs().length === 0;
      return false;
    },
  };
  const cancelled = await runTool(
    tool,
    { agent: "project-only", task: "test", agentScope: "both" },
    { cwd, hasUI: true, ui: rejectingUI } as unknown as ExtensionContext,
  );
  expect(confirmSawNoJob).toBe(true);
  expect((cancelled.content[0] as TextContent).text).toBe("Canceled");
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
  const acceptingUI = { confirm: async () => true };
  const resultSame = await runTool(
    tool,
    { agent: "same", task: "collision", agentScope: "both" },
    { cwd, hasUI: true, ui: acceptingUI } as unknown as ExtensionContext,
  );
  expect((resultSame.content[0] as TextContent).text).toBe("done");
  expect(sentMessages).toHaveLength(3);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages[0]?.content).toBe(
    'Using project agent "same"; user agent with same name also exists.',
  );
  expect(sentMessages[1]?.customType).toBe("subagent-progress");
  expect(sentMessages[2]?.customType).toBe("subagent-result");
  expect((resultSame.details as SubagentDetails).results[0]?.agentSource).toBe(
    "project",
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth subagent tool preserves parent runtime setup semantics", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  const skillDir = path.join(agentDir, "skills", "helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: helper
description: Helper skill
---
Use helper skill.`,
  );
  await writeFile(
    path.join(agentDir, "agents", "runtime-agent.md"),
    `---
name: runtime-agent
description: Runtime agent
skills: helper
---
Runtime prompt`,
  );
  await installFakePi(
    binDir,
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "runtime-agent", task: "runtime task" },
    {
      cwd,
      hasUI: false,
      model: { provider: "fake-provider", id: "fake-model" },
      modelRegistry: registryFixture([]),
    } as unknown as ExtensionContext,
  );
  const args = await readCapturedArgs(cwd);
  const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
  const expectedWarning =
    'Thinking level "high" support could not be confirmed; requesting as-is (provider: fake-provider, model: fake-model)';
  expect((result.content[0] as TextContent).text).toBe(
    `[thinking] ${expectedWarning}\n\ndone`,
  );
  expect(args.join(" ")).toContain(
    "--provider fake-provider --model fake-model",
  );
  expect(args.join(" ")).toContain("--thinking high");
  expect(args.join(" ")).toContain("--no-skills --skill");
  expect(args.join(" ")).toContain(path.join(skillDir, "SKILL.md"));
  expect(args).toContain("--append-system-prompt");
  expect(args.at(-1)).toBe("Task: runtime task");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(promptText).toBe("Runtime prompt");
  expect((result.details as SubagentDetails).results[0]?.model).toBe(
    "fake-provider ･ fake-model ･ high",
  );
  expect((result.details as SubagentDetails).results[0]?.thinkingWarning).toBe(
    expectedWarning,
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth subagent tool forwards live registry to child resolution without overrides", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "live-agent.md"),
    `---
name: live-agent
description: Live registry agent
---
Live prompt`,
  );
  await installFakePi(binDir, CAPTURE_ARGS_PI_SCRIPT);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const live = modelFixture({
    provider: "live-provider",
    id: "live-model",
    reasoning: true,
  });
  const result = await runTool(
    tool,
    { agent: "live-agent", task: "live task" },
    {
      cwd,
      hasUI: false,
      model: { provider: "live-provider", id: "live-model" },
      modelRegistry: registryFixture([live]),
    } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  const args = await readCapturedArgs(cwd);
  const details = result.details as SubagentDetails;
  expect((result.content[0] as TextContent).text).toBe("done");
  expect(args.join(" ")).toContain(
    "--provider live-provider --model live-model",
  );
  expect(args.join(" ")).toContain("--thinking high");
  expect(details.results[0]?.model).toBe("live-provider ･ live-model ･ high");
  expect(details.results[0]?.thinkingWarning).toBeUndefined();
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth subagent tool emits unavailable-registry diagnostic without blocking launch", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "no-registry-agent.md"),
    `---
name: no-registry-agent
description: No registry agent
---
No registry prompt`,
  );
  await installFakePi(binDir, CAPTURE_ARGS_PI_SCRIPT);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await runTool(
      tool,
      { agent: "no-registry-agent", task: "no-registry task" },
      {
        cwd,
        hasUI: false,
        model: { provider: "missing-provider", id: "missing-model" },
      } as unknown as ExtensionContext,
    );
    await waitForSentMessageCount(sentMessages, 2);
    const args = await readCapturedArgs(cwd);
    const details = result.details as SubagentDetails;
    const expectedWarning =
      'Thinking level "high" support could not be confirmed; requesting as-is (provider: missing-provider, model: missing-model)';
    expect(flagValues(args, "--thinking")).toEqual(["high"]);
    expect((result.content[0] as TextContent).text).toBe(
      `[thinking] ${expectedWarning}\n\ndone`,
    );
    expect(details.results[0]?.exitCode).toBe(0);
    expect(details.results[0]?.thinkingWarning).toBe(expectedWarning);
    expect(warnSpy).toHaveBeenCalledWith(
      "Live model registry unavailable; falling back to static catalog.",
    );
    expect(listRunJobs()).toHaveLength(0);
  } finally {
    warnSpy.mockRestore();
  }
});

test("subagent tool abort cancels the background job", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
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
  await runTool(
    tool,
    { agent: "hang", task: "test" },
    makeBareCtx(cwd),
    controller.signal,
  );
  await waitForSentMessage(sentMessages);
  const requestId = requestIdOf(sentMessages);
  controller.abort();
  await waitForRunJobsCleared();
  expect(getProgressState(requestId)?.status).toBe("cancelled");
});

test("subagent tool reports depth limit for an extensions agent without spawning a child", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
echo "should not spawn" > spawn-marker.txt
exit 0
`,
  });
  await writeFile(
    path.join(agentDir, "agents", "deep-ext.md"),
    `---
name: deep-ext
description: Depth-limited agent with extensions
extensions: []
---
Prompt.`,
  );
  process.env.PI_SUBAGENT_DEPTH = "5";
  const result = await runTool(
    tool,
    { agent: "deep-ext", task: "nested" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
  const directDetails = result.details as SubagentDetails;
  const depthText = (result.content[0] as TextContent).text;
  expect(depthText).toStartWith("(failed) ");
  expect(depthText).toContain("Subagent nesting limit reached");
  expect(directDetails.renderedByMessage).toBe(true);
  expect(directDetails.results[0]?.exitCode).toBe(1);
  expect(directDetails.results[0]?.stderr).toBe("");
  expect(directDetails.results[0]?.messages).toBeUndefined();
  expect(directDetails.results[0]?.termination).toBeUndefined();
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("depth");
  expect(await Bun.file(path.join(cwd, "spawn-marker.txt")).exists()).toBe(
    false,
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool lifecycle failure with no latest result preserves raw error message", async () => {
  const sentMessages: SendMessageArg[] = [];
  let threw = false;
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => {
      if (msg.customType === "subagent-result" && !threw) {
        threw = true;
        throw new Error("send rejected");
      }
      sentMessages.push(msg);
    },
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "send fails" },
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toBe("send rejected");
  expect((result.details as SubagentDetails).results).toHaveLength(0);
  const resultMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessages).toHaveLength(1);
  expect(resultMessages[0]?.content).toBe("send rejected");
});

test("positive-depth subagent tool completes successfully at depth 2 (max-depth-minus-one)", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "2";
  const result = await runTool(
    tool,
    { agent: "hang", task: "depth-2" },
    makeBareCtx(cwd),
  );
  const requestId = requestIdOf(sentMessages);
  const directDetails = result.details as SubagentDetails;
  expect((result.content[0] as TextContent).text).toContain("done");
  expect(directDetails.results[0]?.finalOutput).toBe("done");
  expect(getProgressState(requestId)?.status).toBe("success");
  expect(listRunJobs()).toHaveLength(0);
  const resultMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessages).toHaveLength(1);
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
  await runTool(
    tool,
    { agent: "needs-skill", task: "skills" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("missing-skill");
});

test("non-started flows return same shape with and without callback", async () => {
  const sentMessages: SendMessageArg[] = [];
  const callbackInvocations: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    callbackInvocations.push(partial);
  };
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const resultWithCallback = await tool.execute(
    "test-tool-call-1",
    { agent: "non-existent", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(callbackInvocations).toHaveLength(0);
  expect(resultWithCallback.content).toBeDefined();
  expect(resultWithCallback.content[0]?.type).toBe("text");
  if (resultWithCallback.content[0]?.type === "text") {
    expect(resultWithCallback.content[0].text).toContain(
      'Unknown agent: "non-existent"',
    );
  }
  expect(resultWithCallback.details).toBeDefined();
  expect(resultWithCallback.details.mode).toBe("single");
  sentMessages.length = 0;
  const resultWithoutCallback = await tool.execute(
    "test-tool-call-2",
    { agent: "non-existent", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect(resultWithoutCallback.content).toBeDefined();
  expect(resultWithoutCallback.content[0]?.type).toBe("text");
  if (resultWithoutCallback.content[0]?.type === "text") {
    expect(resultWithoutCallback.content[0].text).toContain(
      'Unknown agent: "non-existent"',
    );
  }
  expect(resultWithoutCallback.details).toBeDefined();
  expect(resultWithoutCallback.details.mode).toBe("single");
});

test("subagent invalid context string rejects agent before child spawn", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "context-string.md"),
    `---
name: context-string
description: Context string agent
context: "false"
---
Prompt.`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const result = await runTool(
    tool,
    { agent: "context-string", task: "should not spawn" },
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toContain(
    'Unknown agent: "context-string"',
  );
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
});
