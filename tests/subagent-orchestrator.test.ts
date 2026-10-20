import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  resetProgressStore,
} from "../src/progress/progress.js";
import type {
  SubagentDetails,
  SubagentToolResult,
} from "../src/shared/types.js";
import type { SendMessageArg } from "./helpers.js";
import {
  CAPTURE_PI_ARGS_SH,
  captureStdout,
  getSubagentTool,
  installFakePi,
  makeBareCtx,
  makeSubagentDetails,
  modelFixture,
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
      const requestId = (sentMessages[0]?.details as { requestId?: string })
        ?.requestId;
      if (requestId) {
        expect(getProgressState(requestId)?.status).toBe("success");
      }
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
printf '%s\n' '{"type":"agent_end"}'
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
      const requestId = (sentMessages[0]?.details as { requestId?: string })
        ?.requestId;
      if (requestId) {
        expect(getProgressState(requestId)?.status).toBe("error");
        expect(getProgressState(requestId)?.errorText).toContain(
          "child failure",
        );
      }
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
      const requestId = (sentMessages[0]?.details as { requestId?: string })
        ?.requestId;
      if (requestId) {
        expect(getProgressState(requestId)?.status).toBe("cancelled");
      }
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
      let spawned = false;
      setDefaultDeliveryDeps({
        commandExists: () => true,
        spawnProcess: () => {
          spawned = true;
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
      await Bun.sleep(20);
      expect(spawned).toBe(true);
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
      const requestId = (sentMessages[0]?.details as { requestId?: string })
        ?.requestId;
      if (requestId) {
        expect(getProgressState(requestId)?.status).toBe("success");
      }
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
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "hang", task: "no-model" },
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toBe("done");
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
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
printf '%s\n' '{"type":"agent_end"}'
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
printf '%s\n' '{"type":"agent_end"}'
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
