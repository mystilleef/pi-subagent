import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as childProcess from "../src/child/process.js";
import * as delivery from "../src/notification/delivery.js";
import { setDefaultDeliveryDeps } from "../src/notification/delivery.js";
import {
  listRunJobs,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import {
  emitCompletionAlert,
  formatSubagentToolResult,
} from "../src/orchestration/subagent-orchestrator.js";
import * as usageLedger from "../src/orchestration/usage-ledger.js";
import {
  queryInstanceUsage,
  queryRootRunUsage,
  querySessionUsage,
} from "../src/orchestration/usage-ledger.js";
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  hasProgressResultPosted,
  resetProgressStore,
} from "../src/progress/progress.js";
import type {
  SubagentDetails,
  SubagentToolResult,
} from "../src/shared/types.js";
import * as usageSnapshot from "../src/shared/usage-snapshot.js";
import type { SendMessageArg } from "./helpers.js";
import {
  CAPTURE_ARGS_PI_SCRIPT,
  CAPTURE_PI_ARGS_SH,
  captureStdout,
  emitAgentEnd,
  getSubagentTool,
  installFakePi,
  makeBareCtx,
  makeSubagentDetails,
  modelFixture,
  readCapturedArgs,
  registryFixture,
  requestIdOf,
  runTool,
  setupFakePi,
  setupHooks,
  setupTest,
  waitForRunJobCount,
  waitForRunJobsCleared,
  waitForSentMessage,
  waitForSentMessageCount,
  withEnv,
} from "./helpers.js";

setupHooks();

afterEach(() => {
  resetProgressStore();
  resetRunRegistry();
});

describe("formatSubagentToolResult", () => {
  const emptyDetails: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [],
  };

  test("handles started kind with instanceName and requestId", () => {
    const result = formatSubagentToolResult("builder", {
      kind: "started",
      requestId: "req-123",
      instanceName: "able-falcon",
      makeDetails: () => emptyDetails,
    });
    const typed = result as SubagentToolResult;
    expect(typed.content).toBeDefined();
    expect(typed.details).toBeDefined();
    const text = typed.content[0]?.["text"] ?? "";
    expect(text).toContain("builder");
    expect(text).toContain("able-falcon");
    expect(text).toContain("req-123");
    expect(text).toContain("started");
  });

  test("returns completed result directly", () => {
    const completedResult: SubagentToolResult = {
      content: [{ type: "text", text: "done" }],
      details: emptyDetails,
    };
    const result = formatSubagentToolResult("builder", {
      kind: "completed",
      result: completedResult,
    });
    expect(result).toBe(completedResult);
  });

  test("handles not_found kind", () => {
    const result = formatSubagentToolResult("unknown", {
      kind: "not_found",
      makeDetails: () => emptyDetails,
    });
    const typed = result as SubagentToolResult;
    const text = typed.content[0]?.["text"] ?? "";
    expect(text).toContain('Unknown agent: "unknown"');
    expect(typed.details).toBeDefined();
  });

  test("handles cancelled kind", () => {
    const result = formatSubagentToolResult("builder", {
      kind: "cancelled",
      makeDetails: () => emptyDetails,
    });
    const typed = result as SubagentToolResult;
    const text = typed.content[0]?.["text"] ?? "";
    expect(text).toBe("Canceled");
    expect(typed.details).toBeDefined();
  });
});

test("subagent tool result adapter passes through completed results", () => {
  const completed = {
    content: [{ type: "text" as const, text: "done" }],
    details: {
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      renderedByMessage: true as const,
      results: [],
    },
  };
  expect(
    formatSubagentToolResult("hang", { kind: "completed", result: completed }),
  ).toBe(completed);
});

test.each([
  {
    name: "formatSubagentToolResult returns not_found text",
    kind: "not_found",
    expectedText: 'Unknown agent: "hang"',
  },
  {
    name: "formatSubagentToolResult returns cancelled text",
    kind: "cancelled",
    expectedText: "Canceled",
  },
])("$name", (row) => {
  const result = formatSubagentToolResult("hang", {
    kind: row.kind,
    makeDetails: makeEmptySubagentDetails,
  });
  expect((result.content[0] as TextContent).text).toBe(row.expectedText);
});

test("formatSubagentToolResult returns started text", () => {
  const result = formatSubagentToolResult("hang", {
    kind: "started",
    requestId: "req-1",
    instanceName: "adj-word",
    makeDetails: makeEmptySubagentDetails,
  });
  expect((result.content[0] as TextContent).text).toBe(
    "Subagent hang adj-word started (job: req-1)",
  );
});

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
  const result = await runTool(
    tool,
    { agent: "hang", task: "test" },
    makeBareCtx(cwd),
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
  const ctx = makeBareCtx(cwd);
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

test("prepareSubagentJob returns aborted when host signal fires during sendMessage", async () => {
  const sentMessages: SendMessageArg[] = [];
  const controller = new AbortController();
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => {
      sentMessages.push(msg);
      controller.abort();
    },
  });
  const result = await runTool(
    tool,
    { agent: "hang", task: "test" },
    makeBareCtx(cwd),
    controller.signal,
  );
  expect((result.content[0] as TextContent).text).toBe("Canceled");
  const requestId = requestIdOf(sentMessages);
  expect(getProgressState(requestId)?.status).toBe("cancelled");
  expect(listRunJobs()).toHaveLength(0);
});

test("startSubagentJob depth 0 cancels in setImmediate when signal already aborted", async () => {
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
  const requestId = requestIdOf(sentMessages);
  expect(listRunJobs()).toHaveLength(1);
  controller.abort();
  await waitForRunJobsCleared();
  expect(getProgressState(requestId)?.status).toBe("cancelled");
});

// --- emitCompletionAlert tests ---
test("emitCompletionAlert emits bell on TTY", () => {
  captureStdout(true, (writeCalls) => {
    const state = makeProgressState({
      status: "success",
      finalOutput: "all tests pass",
    });
    emitCompletionAlert(state);
    expect(writeCalls).toContain("\x07");
  });
});

test("emitCompletionAlert skips on non-TTY", () => {
  captureStdout(false, (writeCalls) => {
    const state = makeProgressState({
      status: "success",
      finalOutput: "all tests pass",
    });
    emitCompletionAlert(state);
    expect(writeCalls).toEqual([]);
  });
});

test("emitCompletionAlert skips for cancelled jobs", () => {
  captureStdout(true, (writeCalls) => {
    const state = makeProgressState({ status: "cancelled" });
    emitCompletionAlert(state);
    expect(writeCalls).toEqual([]);
  });
});

test("emitCompletionAlert emits bell for error jobs", () => {
  captureStdout(true, (writeCalls) => {
    const state = makeProgressState({
      status: "error",
      errorText: "child process crashed",
    });
    emitCompletionAlert(state);
    expect(writeCalls).toContain("\x07");
  });
});

test("emitCompletionAlert skips absent state", () => {
  expect(() => emitCompletionAlert(undefined)).not.toThrow();
});

test("emitCompletionAlert with batch notifications enabled emits bell on TTY", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      captureStdout(true, (writeCalls) => {
        const state = makeProgressState({
          status: "success",
          finalOutput: "task completed",
        });
        emitCompletionAlert(state);
        expect(writeCalls).toContain("\x07");
      });
    },
  );
});

test("emitCompletionAlert with batch notifications enabled does not bell on non-TTY", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      captureStdout(false, (writeCalls) => {
        const state = makeProgressState({
          status: "error",
          errorText: "build failed",
        });
        expect(() => emitCompletionAlert(state)).not.toThrow();
        expect(writeCalls).toEqual([]);
      });
    },
  );
});

test("emitCompletionAlert with batch notifications handles cancelled by skipping", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      const state = makeProgressState({ status: "cancelled" });
      expect(() => emitCompletionAlert(state)).not.toThrow();
    },
  );
});

test("emitCompletionAlert emits bell on TTY when nested (depth > 0)", () => {
  withEnv(
    {
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "0",
    },
    () => {
      captureStdout(true, (writeCalls) => {
        const state = makeProgressState({
          status: "success",
          finalOutput: "nested task completed",
        });
        emitCompletionAlert(state);
        expect(writeCalls).toContain("\x07");
      });
    },
  );
});

test("emitCompletionAlert suppresses desktop notification when nested (depth > 0)", () => {
  withEnv(
    {
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      let spawned = false;
      setDefaultDeliveryDeps({
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      const state = makeProgressState({
        status: "success",
        finalOutput: "done",
      });
      emitCompletionAlert(state);
      expect(spawned).toBe(false);
    },
  );
});

test("per-job notification completes lifecycle without crashing", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "1";
      const result = await runTool(
        tool,
        { agent: "hang", task: "per-job notify" },
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect((result.content[0] as TextContent).text).toBe("done");
      expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
      const requestId = requestIdOf(sentMessages);
      expect(getProgressState(requestId)?.status).toBe("success");
      expect(hasProgressResultPosted(requestId)).toBe(true);
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("per-job notification completes lifecycle for error jobs", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      const sentMessages: SendMessageArg[] = [];
      const { binDir, cwd } = await setupFakePi();
      await installFakePi(
        binDir,
        `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"error output"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}},"errorMessage":"child failure"}}'
${emitAgentEnd()}
exit 1
`,
      );
      const tool = getSubagentTool({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "1";
      const result = await runTool(
        tool,
        { agent: "hang", task: "per-job error" },
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
      const requestId = requestIdOf(sentMessages);
      expect(getProgressState(requestId)?.status).toBe("error");
      expect(getProgressState(requestId)?.errorText).toContain("child failure");
      expect(hasProgressResultPosted(requestId)).toBe(true);
      expect(result.details.renderedByMessage).toBe(true);
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("per-job notification with cancelled state does not crash", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      const sentMessages: SendMessageArg[] = [];
      const controller = new AbortController();
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
      const executePromise = runTool(
        tool,
        { agent: "hang", task: "per-job cancel" },
        makeBareCtx(cwd),
        controller.signal,
      );
      await waitForSentMessage(sentMessages);
      controller.abort();
      const result = await executePromise;
      expect((result.content[0] as TextContent).text).toBe("Canceled");
      const requestId = requestIdOf(sentMessages);
      expect(getProgressState(requestId)?.status).toBe("cancelled");
      expect(hasProgressResultPosted(requestId)).toBe(true);
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("per-job notification delivers at depth 0 via lifecycle", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      const notified = Promise.withResolvers<void>();
      setDefaultDeliveryDeps({
        commandExists: () => true,
        spawnProcess: () => {
          notified.resolve();
          return {};
        },
      });
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "0";
      await runTool(
        tool,
        { agent: "hang", task: "per-job depth-0" },
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
      await notified.promise;
      await waitForRunJobsCleared();
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("per-job notification skipped when nested (depth > 0)", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      let spawned = false;
      setDefaultDeliveryDeps({
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      await runTool(
        tool,
        { agent: "hang", task: "per-job nested" },
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect(spawned).toBe(false);
    },
  );
});

test("batch notification skips bell when not last job", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    async () => {
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
        piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
      });
      const ctx = makeBareCtx(cwd);
      const promises = [
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
      ];
      await waitForRunJobCount(2);
      const jobs = listRunJobs();
      expect(jobs).toHaveLength(2);
      jobs[0]?.controller.abort("cleanup");
      await waitForRunJobCount(1);
      jobs[1]?.controller.abort("cleanup");
      await Promise.all(promises);
      await waitForRunJobsCleared();
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("batch notification does not crash for successful lifecycle completion", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    async () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "1";
      const result = await runTool(
        tool,
        { agent: "hang", task: "batch notify" },
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect((result.content[0] as TextContent).text).toBe("done");
      expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
      const requestId = requestIdOf(sentMessages);
      expect(getProgressState(requestId)?.status).toBe("success");
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

// --- deliverDesktopCompletionNotification indirect verification ---
test("emitCompletionAlert with PI_SUBAGENT_DESKTOP_NOTIFICATIONS=1 calls notification path", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      const state = makeProgressState({
        status: "success",
        finalOutput: "task completed",
        durationMs: 5000,
      });
      expect(() => emitCompletionAlert(state)).not.toThrow();
    },
  );
});

test("emitCompletionAlert with PI_SUBAGENT_DESKTOP_NOTIFICATIONS=0 skips notification path", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "0",
    },
    () => {
      captureStdout(false, (writeCalls) => {
        const state = makeProgressState({
          status: "success",
          finalOutput: "task completed",
        });
        expect(() => emitCompletionAlert(state)).not.toThrow();
        expect(writeCalls).toEqual([]);
      });
    },
  );
});

test("emitCompletionAlert with PI_SUBAGENT_DESKTOP_NOTIFICATIONS=1 and PI_SUBAGENT_NOTIFY_PER_JOB=1 still emits bell via batch fallback", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    () => {
      captureStdout(true, (writeCalls) => {
        const state = makeProgressState({
          status: "success",
          finalOutput: "task completed",
        });
        emitCompletionAlert(state);
        expect(writeCalls).toContain("\x07");
      });
    },
  );
});

test("emitCompletionAlert swallows desktop notification rejection", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      const spy = spyOn(delivery, "deliverNotification").mockImplementation(
        () => Promise.reject(new Error("notification delivery failed")),
      );
      try {
        captureStdout(true, (writeCalls) => {
          const state = makeProgressState({
            status: "success",
            finalOutput: "task completed",
          });
          expect(() => emitCompletionAlert(state)).not.toThrow();
          expect(writeCalls).toContain("\x07");
        });
      } finally {
        spy.mockRestore();
      }
    },
  );
});

test("prepareSubagentJob omits parent model when ctx.model is absent", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: CAPTURE_ARGS_PI_SCRIPT,
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "no-model" },
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toBe("done");
  const args = await readCapturedArgs(cwd);
  const argsText = args.join(" ");
  expect(argsText).not.toContain("--provider");
  expect(argsText).not.toContain("--model");
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.model).toBe("off");
  expect(listRunJobs()).toHaveLength(0);
});

test("project agent without user collision sends no collision warning", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-only.md"),
    `---
name: project-only
description: Project only
---
Project prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "project-only", task: "no-collision", agentScope: "both" },
    {
      cwd,
      hasUI: true,
      ui: { confirm: async () => true },
    } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toBe("done");
  const collisionWarnings = sentMessages.filter(
    (msg) =>
      msg.customType === "subagent-progress" &&
      typeof msg.content === "string" &&
      msg.content.includes("user agent with same name"),
  );
  expect(collisionWarnings).toHaveLength(0);
  expect((result.details as SubagentDetails).results[0]?.agentSource).toBe(
    "project",
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("startSubagentJob depth-0 cancels via cancelStartedJob when signal aborts after registration", async () => {
  const sentMessages: SendMessageArg[] = [];
  const controller = new AbortController();
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
  await runTool(
    tool,
    { agent: "hang", task: "cancel-after-start" },
    makeBareCtx(cwd),
    controller.signal,
  );
  const requestId = requestIdOf(sentMessages);
  expect(listRunJobs()).toHaveLength(1);
  expect(getProgressState(requestId)?.status).toBe("running");
  controller.abort("host cancel");
  await waitForRunJobsCleared();
  expect(getProgressState(requestId)?.status).toBe("cancelled");
  expect(hasProgressResultPosted(requestId)).toBe(false);
});

test("formatSubagentToolResult returns completed result unchanged preserving all fields", () => {
  const completedResult: SubagentToolResult = {
    content: [{ type: "text" as const, text: "done" }],
    details: {
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      renderedByMessage: true as const,
      results: [
        {
          instanceName: "adj-word",
          agent: "hang",
          agentSource: "user" as const,
          task: "test task",
          finalOutput: "done",
          exitCode: 0,
          stderr: "",
          durationMs: 5000,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const result = formatSubagentToolResult("hang", {
    kind: "completed",
    result: completedResult,
  });
  // Returns the exact same object reference (pass-through)
  expect(result).toBe(completedResult);
  expect(result.details.renderedByMessage).toBe(true);
  expect(result.details.results[0]?.finalOutput).toBe("done");
});

// ── Registry forwarding through orchestrator ──
test("orchestrator forwards ctx.modelRegistry to runSingleAgent affecting thinking resolution", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  await writeFile(
    path.join(agentDir, "agents", "registry-agent.md"),
    `---
name: registry-agent
description: Registry forwarding agent
provider: openai
model: gpt-4
thinking: high
---
Registry prompt.`,
  );
  const live = modelFixture({
    provider: "openai",
    id: "gpt-4",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
    },
  });
  const registry = registryFixture([live]);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "registry-agent", task: "registry task" },
    {
      cwd,
      hasUI: false,
      model: { provider: "openai", id: "gpt-4" },
      modelRegistry: registry,
    } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toBe("done");
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.thinkingWarning).toBeUndefined();
  expect(details.results[0]?.model).toBe("openai ･ gpt-4 ･ high");
  expect(listRunJobs()).toHaveLength(0);
});

test("orchestrator registry miss falls back to static catalog thinking resolution", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  await writeFile(
    path.join(agentDir, "agents", "registry-miss-agent.md"),
    `---
name: registry-miss-agent
description: Registry miss agent
provider: openai
model: gpt-4
thinking: high
---
Registry miss prompt.`,
  );
  const registry = registryFixture([]);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "registry-miss-agent", task: "registry miss" },
    {
      cwd,
      hasUI: false,
      model: { provider: "openai", id: "gpt-4" },
      modelRegistry: registry,
    } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toContain("[thinking]");
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.thinkingWarning).toContain('using "off" instead');
  expect(details.results[0]?.model).toBe("openai ･ gpt-4 ･ off");
  expect(listRunJobs()).toHaveLength(0);
});

const makeEmptySubagentDetails = () => makeSubagentDetails([]);

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

function makeLaunchCtx(
  cwd: string,
  overrides?: Partial<ExtensionContext>,
): ExtensionContext {
  return { ...makeBareCtx(cwd), ...overrides } as unknown as ExtensionContext;
}

describe("registered-job lifecycle accounting", () => {
  test("registers root jobs at depth zero with session-spanning ordinals and started-handle snapshots", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
    });
    process.env.PI_SUBAGENT_DEPTH = "0";

    const handles = [];
    for (const task of ["first", "second", "third"]) {
      handles.push(
        await runTool(tool, { agent: "hang", task }, makeLaunchCtx(cwd)),
      );
    }

    const details = handles.map((handle) => handle.details as SubagentDetails);
    expect(details.map((d) => d.results)).toEqual([[], [], []]);
    expect(details.map((d) => d.usageTree?.status)).toEqual([
      "running",
      "running",
      "running",
    ]);
    expect(details.map((d) => d.usageTree?.ordinal)).toEqual([1, 2, 3]);
    expect(sentMessages[0]?.details).toEqual({
      agent: "hang",
      instanceName: details[0]?.usageTree?.instanceName,
      requestId: details[0]?.usageTree?.id,
    });

    const session = querySessionUsage();
    expect(session.runs).toHaveLength(3);
    expect(session.rollup.statuses.running).toBe(3);

    for (const job of listRunJobs()) job.controller.abort("cleanup");
    await waitForRunJobsCleared();
  });

  test("carries the terminal snapshot beside unchanged results for nested jobs", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
    });
    process.env.PI_SUBAGENT_DEPTH = "1";

    const result = await runTool(
      tool,
      { agent: "hang", task: "nested" },
      makeLaunchCtx(cwd),
    );
    const requestId = requestIdOf(sentMessages);
    expect(queryInstanceUsage(requestId)?.instance.status).toBe("success");
    const details = result.details as SubagentDetails;
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).not.toHaveProperty("usageTree");
    expect(details.usageTree?.id).toBe(requestId);
    expect(details.usageTree?.status).toBe("success");
  });

  test("fills terminal results with session ordinals when child results omit them", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
    });
    process.env.PI_SUBAGENT_DEPTH = "0";
    for (const task of ["first-root", "second-root"]) {
      const before = sentMessages.length;
      await runTool(tool, { agent: "hang", task }, makeLaunchCtx(cwd));
      await waitForSentMessageCount(sentMessages, before + 2);
      await waitForRunJobsCleared();
    }
    const terminalDetails = sentMessages
      .filter((msg) => msg.customType === "subagent-result")
      .map((msg) => msg.details as SubagentDetails);
    expect(terminalDetails).toHaveLength(2);
    expect(
      terminalDetails.map((details) => details.results[0]?.ordinal),
    ).toEqual([1, 2]);
  });

  test("creates no ledger node and emits no snapshot on pre-registration rejections", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
    });
    const projectAgentsDir = path.join(cwd, ".pi", "agents");
    await mkdir(projectAgentsDir, { recursive: true });
    await writeFile(
      path.join(projectAgentsDir, "proj-only.md"),
      `---
name: proj-only
description: Project agent
---
Prompt.`,
    );
    process.env.PI_SUBAGENT_DEPTH = "0";
    const ctx = makeLaunchCtx(cwd);

    const notFoundResult = await runTool(
      tool,
      { agent: "missing-agent", task: "x" },
      ctx,
    );
    expect((notFoundResult.details as SubagentDetails).results).toHaveLength(0);

    const preAborted = new AbortController();
    preAborted.abort();
    const abortedResult = await runTool(
      tool,
      { agent: "hang", task: "x" },
      ctx,
      preAborted.signal,
    );
    expect((abortedResult.details as SubagentDetails).results).toHaveLength(0);

    const declinedResult = await runTool(
      tool,
      { agent: "proj-only", task: "x" },
      makeLaunchCtx(cwd, {
        hasUI: true,
        ui: {
          confirm: async () => false,
          notify: () => {},
        } as unknown as ExtensionContext["ui"],
      }),
    );
    expect((declinedResult.details as SubagentDetails).results).toHaveLength(0);
    expect(querySessionUsage().runs).toHaveLength(0);
    expect(queryRootRunUsage("hang")).toBeUndefined();
    expect(sentMessages).toHaveLength(0);
  });

  test("transitions early pre-execution cancellation in prepareSubagentJob with duration and snapshot", async () => {
    const sentMessages: SendMessageArg[] = [];
    const controller = new AbortController();
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => {
        sentMessages.push(msg);
        controller.abort();
      },
    });
    process.env.PI_SUBAGENT_DEPTH = "0";

    const result = await runTool(
      tool,
      { agent: "hang", task: "early-cancel" },
      makeLaunchCtx(cwd),
      controller.signal,
    );
    const requestId = requestIdOf(sentMessages);
    expect((result.content[0] as TextContent).text).toBe("Canceled");

    expect((result.details as SubagentDetails).results).toHaveLength(0);
    const tree = (result.details as SubagentDetails).usageTree;
    expect(tree?.id).toBe(requestId);
    expect(tree?.status).toBe("cancelled");
    expect(tree?.durationMs).toEqual(expect.any(Number));

    const stored = queryInstanceUsage(requestId)?.instance;
    expect(stored?.status).toBe("cancelled");
    expect(stored?.durationMs).toEqual(expect.any(Number));
  });

  test("transitions depth-0 setImmediate pre-execution cancellation with duration and no child spawn", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { binDir, cwd } = await setupFakePi();
    const markerFile = path.join(cwd, "spawned.txt");
    await installFakePi(
      binDir,
      `#!/bin/sh
printf 'spawned\n' > "${markerFile}"
exit 0
`,
    );
    const tool = getSubagentTool({
      sendMessage: (msg) => sentMessages.push(msg),
    });
    process.env.PI_SUBAGENT_DEPTH = "0";
    const controller = new AbortController();

    const started = await runTool(
      tool,
      { agent: "hang", task: "cancel-before-setImmediate" },
      makeLaunchCtx(cwd),
      controller.signal,
    );
    const requestId = requestIdOf(sentMessages);
    expect((started.details as SubagentDetails).usageTree?.status).toBe(
      "running",
    );

    controller.abort("pre-exec abort");
    await waitForRunJobsCleared();

    expect(await Bun.file(markerFile).exists()).toBe(false);
    const stored = queryInstanceUsage(requestId)?.instance;
    expect(stored?.status).toBe("cancelled");
    expect(stored?.durationMs).toEqual(expect.any(Number));
  });

  test("transitions thrown runSingleAgent failure without child result to error and cancelled snapshots", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
    });
    process.env.PI_SUBAGENT_DEPTH = "1";

    spyOn(childProcess, "runSingleAgent").mockRejectedValueOnce(
      new Error("boom without child result"),
    );
    const errResult = await runTool(
      tool,
      { agent: "hang", task: "throws" },
      makeBareCtx(cwd),
    );
    const errRequestId = requestIdOf(sentMessages);
    expect((errResult.content[0] as TextContent).text).toBe(
      "boom without child result",
    );
    expect((errResult.details as SubagentDetails).results).toHaveLength(0);
    const errTree = (errResult.details as SubagentDetails).usageTree;
    expect(errTree?.id).toBe(errRequestId);
    expect(errTree?.status).toBe("error");
    expect(errTree?.durationMs).toEqual(expect.any(Number));
    expect(
      (sentMessages.at(-1)?.details as SubagentDetails | undefined)?.usageTree
        ?.status,
    ).toBe("error");

    const abortController = new AbortController();
    const sentAbortMessages: SendMessageArg[] = [];
    const abortTool = getSubagentTool({
      sendMessage: (msg) => {
        sentAbortMessages.push(msg);
        if (msg.customType === "subagent-progress") {
          // abort only after ready, right when runSingleAgent runs
        }
      },
    });
    spyOn(childProcess, "runSingleAgent").mockImplementationOnce(async () => {
      abortController.abort("aborted throw");
      throw new Error("aborted during run");
    });
    const cancelResult = await runTool(
      abortTool,
      { agent: "hang", task: "throws-aborted" },
      makeBareCtx(cwd),
      abortController.signal,
    );
    expect((cancelResult.content[0] as TextContent).text).toBe("Canceled");
    const cancelTree = (cancelResult.details as SubagentDetails).usageTree;
    expect(cancelTree?.status).toBe("cancelled");
    expect(cancelTree?.durationMs).toEqual(expect.any(Number));
    expect(sentAbortMessages.at(-1)?.customType).toBe("subagent-result");
  });

  test("isolates ledger failures without altering launch, self usage, delivery, or alerts", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}],"usage":{"input":12,"output":8,"cacheRead":3,"cacheWrite":1,"totalTokens":24,"cost":{"total":0.05}}}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":5,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":10,"cost":{"total":0.02}}}}'
${emitAgentEnd()}
exit 0
`,
    });
    process.env.PI_SUBAGENT_DEPTH = "1";

    spyOn(usageLedger, "registerRootInstance").mockImplementation(() => {
      throw new Error("register boom");
    });
    spyOn(usageLedger, "updateInstanceSelfUsage").mockImplementation(() => ({
      ok: false,
      error: "rejected usage",
    }));
    spyOn(usageLedger, "transitionInstanceStatus").mockImplementation(() => {
      throw new Error("transition boom");
    });
    spyOn(usageLedger, "snapshotInstanceUsage").mockImplementation(() => {
      throw new Error("snapshot boom");
    });
    spyOn(usageSnapshot, "serializeUsageSnapshot").mockImplementation(() => {
      throw new Error("serialize boom");
    });

    const result = await runTool(
      tool,
      { agent: "hang", task: "fault isolation" },
      makeLaunchCtx(cwd),
    );

    expect((result.content[0] as TextContent).text).toBe("done");
    const details = result.details as SubagentDetails;
    expect(details.results[0]?.usage).toMatchObject({
      input: 17,
      output: 13,
      cacheRead: 3,
      cacheWrite: 1,
      turns: 2,
    });
    expect(details.results[0]?.usage.cost).toBeCloseTo(0.07, 10);
    expect(details.usageTree).toBeUndefined();
    const requestId = requestIdOf(sentMessages);
    expect(getProgressState(requestId)?.status).toBe("success");
    expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
    expect(listRunJobs()).toHaveLength(0);
  });

  test("never leaks running snapshot when terminal transition fails after prior registration", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
    });
    process.env.PI_SUBAGENT_DEPTH = "1";

    spyOn(usageLedger, "transitionInstanceStatus").mockReturnValue({
      ok: false,
      error: "transition failed",
    });

    let capturedBell = false;
    await captureStdout(true, async (writes) => {
      const result = await runTool(
        tool,
        { agent: "hang", task: "failed terminal transition" },
        makeBareCtx(cwd),
      );
      expect((result.content[0] as TextContent).text).toBe("done");
      expect((result.details as SubagentDetails).usageTree).toBeUndefined();
      capturedBell = writes.includes("\x07");
    });
    expect(capturedBell).toBe(true);
    expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  });

  test("persists exactly one subagent-usage v1 entry per depth-0 terminal transition across success, error, and cancellations", async () => {
    const appended: Array<{ customType: string; data: unknown }> = [];
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    });
    process.env.PI_SUBAGENT_DEPTH = "0";

    // 1. Success terminal transition appends once and never while running.
    await runTool(
      tool,
      { agent: "hang", task: "root-success" },
      makeLaunchCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    await waitForRunJobsCleared();
    expect(appended).toHaveLength(1);
    expect(appended[0]?.customType).toBe("subagent-usage");
    const entry1 = appended[0]?.data as {
      v: number;
      run: { status: string; durationMs?: number };
    };
    expect(entry1.v).toBe(1);
    expect(entry1.run.status).toBe("success");
    expect(entry1.run.durationMs).toEqual(expect.any(Number));

    // 2. Early pre-execution cancellation in prepareSubagentJob appends once.
    const earlyController = new AbortController();
    const earlySent: SendMessageArg[] = [];
    const earlyTool = getSubagentTool({
      sendMessage: (msg) => {
        earlySent.push(msg);
        earlyController.abort();
      },
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    });
    await runTool(
      earlyTool,
      { agent: "hang", task: "early-cancel-persist" },
      makeLaunchCtx(cwd),
      earlyController.signal,
    );
    expect(appended).toHaveLength(2);
    const entry2 = appended[1]?.data as { v: number; run: { status: string } };
    expect(entry2.v).toBe(1);
    expect(entry2.run.status).toBe("cancelled");

    // 3. Queued setImmediate pre-execution cancellation appends once.
    const queuedController = new AbortController();
    await runTool(
      tool,
      { agent: "hang", task: "queued-cancel-persist" },
      makeLaunchCtx(cwd),
      queuedController.signal,
    );
    expect(appended).toHaveLength(2);
    queuedController.abort("stop queued");
    await waitForRunJobsCleared();
    expect(appended).toHaveLength(3);
    const entry3 = appended[2]?.data as { v: number; run: { status: string } };
    expect(entry3.v).toBe(1);
    expect(entry3.run.status).toBe("cancelled");

    // 4. Thrown runSingleAgent failure appends error entry once.
    const beforeThrowCount = sentMessages.length;
    const throwSpy = spyOn(
      childProcess,
      "runSingleAgent",
    ).mockRejectedValueOnce(new Error("root throw"));
    try {
      await runTool(
        tool,
        { agent: "hang", task: "root-throw" },
        makeLaunchCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, beforeThrowCount + 2);
      await waitForRunJobsCleared();
    } finally {
      throwSpy.mockRestore();
    }
    expect(appended).toHaveLength(4);
    const entry4 = appended[3]?.data as { v: number; run: { status: string } };
    expect(entry4.v).toBe(1);
    expect(entry4.run.status).toBe("error");
  });

  test("skips persistence at positive depth", async () => {
    const appended: Array<{ customType: string; data: unknown }> = [];
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
      piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
    });

    // Positive depth never persists.
    process.env.PI_SUBAGENT_DEPTH = "1";
    const nestedController = new AbortController();
    const nestedPromise = runTool(
      tool,
      { agent: "hang", task: "nested-no-persist" },
      makeLaunchCtx(cwd),
      nestedController.signal,
    );
    await waitForSentMessageCount(sentMessages, 1);
    nestedController.abort("done");
    await nestedPromise;
    expect(appended).toHaveLength(0);
  });

  test("isolates appendEntry failures without altering usage, result delivery, or completion alerts", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      appendEntry: () => {
        throw new Error("appendEntry disk error");
      },
      piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":11,"output":7,"cacheRead":2,"cacheWrite":1,"totalTokens":21,"cost":{"total":0.03}}}}'
${emitAgentEnd()}
exit 0
`,
    });
    process.env.PI_SUBAGENT_DEPTH = "0";

    let capturedBell = false;
    await captureStdout(true, async (writes) => {
      await runTool(
        tool,
        { agent: "hang", task: "append-fails" },
        makeLaunchCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      await waitForRunJobsCleared();
      capturedBell = writes.includes("\x07");
    });

    expect(capturedBell).toBe(true);
    const resultMsg = sentMessages.at(-1);
    expect(resultMsg?.customType).toBe("subagent-result");
    const details = resultMsg?.details as SubagentDetails;
    expect(details.results[0]?.usage).toMatchObject({
      input: 11,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      turns: 1,
    });
    expect(details.usageTree?.status).toBe("success");
    expect(querySessionUsage().rollup.usage.input).toBe(11);
  });
});

describe("ledger fault-isolation catch paths", () => {
  const DONE_PI_SCRIPT = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":5,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":8,"cost":{"total":0.01}}}}'
${emitAgentEnd()}
exit 0
`;

  test("isolates updateInstanceSelfUsage throws without losing terminal snapshots", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      piScript: DONE_PI_SCRIPT,
    });
    process.env.PI_SUBAGENT_DEPTH = "1";

    spyOn(usageLedger, "updateInstanceSelfUsage").mockImplementation(() => {
      throw "non-error throw";
    });

    const result = await runTool(
      tool,
      { agent: "hang", task: "update throw" },
      makeLaunchCtx(cwd),
    );
    expect((result.content[0] as TextContent).text).toBe("done");
    const details = result.details as SubagentDetails;
    expect(details.usageTree?.id).toBe(requestIdOf(sentMessages));
    expect(details.usageTree?.status).toBe("success");
    expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  });

  test("drops usageTree when snapshot serialization throws after a successful transition", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      piScript: DONE_PI_SCRIPT,
    });
    process.env.PI_SUBAGENT_DEPTH = "1";

    spyOn(usageSnapshot, "serializeUsageSnapshot").mockImplementation(() => {
      throw new Error("serialize boom");
    });

    const result = await runTool(
      tool,
      { agent: "hang", task: "serialize throw" },
      makeLaunchCtx(cwd),
    );
    expect((result.content[0] as TextContent).text).toBe("done");
    expect((result.details as SubagentDetails).usageTree).toBeUndefined();
    expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  });

  test("child usage tree delivery survives attachChildSubtree throws", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      piScript: `#!/bin/sh
printf '%s\\n' '{"type":"tool_execution_update","toolName":"subagent","partialResult":{"content":[{"type":"text","text":"nested"}],"details":{"results":[],"usageTree":{"id":"nested-child","agent":"worker"}}}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}'
${emitAgentEnd()}
exit 0
`,
    });
    process.env.PI_SUBAGENT_DEPTH = "1";

    const attachSpy = spyOn(
      usageLedger,
      "attachChildSubtree",
    ).mockImplementation(() => {
      throw new Error("attach boom");
    });

    const result = await runTool(
      tool,
      { agent: "hang", task: "attach throw" },
      makeLaunchCtx(cwd),
    );
    expect((result.content[0] as TextContent).text).toBe("done");
    expect(attachSpy).toHaveBeenCalledWith(expect.any(String), {
      id: "nested-child",
      agent: "worker",
    });
    expect((result.details as SubagentDetails).usageTree?.status).toBe(
      "success",
    );
    expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  });

  test("falls back to undefined usageTree when the terminal fallback query throws", async () => {
    const sentMessages: SendMessageArg[] = [];
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      piScript: DONE_PI_SCRIPT,
    });
    process.env.PI_SUBAGENT_DEPTH = "1";

    spyOn(usageLedger, "transitionInstanceStatus").mockReturnValue({
      ok: false,
      error: "transition failed",
    });
    spyOn(usageLedger, "queryInstanceUsage").mockImplementation(() => {
      throw new Error("query boom");
    });

    const result = await runTool(
      tool,
      { agent: "hang", task: "query throw" },
      makeLaunchCtx(cwd),
    );
    expect((result.content[0] as TextContent).text).toBe("done");
    expect((result.details as SubagentDetails).usageTree).toBeUndefined();
    expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  });
});
