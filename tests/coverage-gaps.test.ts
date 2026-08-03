import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { parseChildEventLine } from "../src/child/child-events.js";
import { makeEmitUpdate, runSingleAgent } from "../src/child/process.js";
import type { SleepInhibitorAdapter } from "../src/child/termination.js";
import {
  acquireChildSleepInhibitor,
  terminateChildProcess,
} from "../src/child/termination.js";
import { jobsCommandHandler } from "../src/orchestration/jobs-command.js";
import {
  registerRunJob,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import {
  extractSemanticToolTarget,
  isStatusOnlyFailure,
  isStatusOnlySuccess,
  makeToolPreview,
  normalizeAndTruncate,
  normalizeSummaryValue,
  normalizeTerminalSentence,
  truncateText,
} from "../src/output/normalize.js";
import {
  createProgressState,
  finalizeProgressState,
  resetProgressStore,
} from "../src/progress/progress.js";
import type { SingleResult } from "../src/shared/types.js";
import {
  detectMessageError,
  getPiInvocation,
  getSubagentDepth,
  hasSubagentFailed,
  resolveAgentSkillArgs,
  subagentDepthEnv,
  writePromptToTempFile,
} from "../src/shared/utils.js";
import {
  hangAgent,
  makeCommandContext,
  makeSubagentDetails,
  setupHooks,
  setupTest,
} from "./helpers.js";

setupHooks();

describe("normalize.ts coverage gaps", () => {
  test("normalizeSummaryValue strips backticks and bold markers", () => {
    expect(normalizeSummaryValue("`hello`")).toBe("hello");
    expect(normalizeSummaryValue("**world**")).toBe("world");
    expect(normalizeSummaryValue("  spaced  ")).toBe("spaced");
    expect(normalizeSummaryValue("multiple   spaces")).toBe("multiple spaces");
  });

  test("extractSemanticToolTarget returns semantic key values", () => {
    expect(extractSemanticToolTarget({ command: "ls -la" })).toBe("ls -la");
    expect(extractSemanticToolTarget({ path: "/tmp/file" })).toBe("/tmp/file");
    expect(extractSemanticToolTarget({ agent: "builder" })).toBe("builder");
    expect(extractSemanticToolTarget({ query: "search term" })).toBe(
      "search term",
    );
    expect(extractSemanticToolTarget({ url: "https://example.com" })).toBe(
      "https://example.com",
    );
    expect(extractSemanticToolTarget({ action: "run" })).toBe("run");
    expect(extractSemanticToolTarget({ name: "test" })).toBe("test");
  });

  test("extractSemanticToolTarget skips secret keys and JWTs", () => {
    expect(
      extractSemanticToolTarget({ secretKey: "sensitive", command: "ls" }),
    ).toBe("ls");
    expect(
      extractSemanticToolTarget({
        token: "eyJabc.def.ghi",
        command: "ls",
      }),
    ).toBe("ls");
    expect(
      extractSemanticToolTarget({
        password: "hidden",
        path: "/tmp",
      }),
    ).toBe("/tmp");
  });

  test("extractSemanticToolTarget returns empty string for no valid keys", () => {
    expect(extractSemanticToolTarget({})).toBe("");
    expect(extractSemanticToolTarget({ secret: "value" })).toBe("");
    expect(extractSemanticToolTarget({ key: "" })).toBe("");
  });

  test("extractSemanticToolTarget returns JSON when forceJson is true", () => {
    const args = { command: "ls" };
    expect(extractSemanticToolTarget(args, true)).toBe(JSON.stringify(args));
  });

  test("truncateText truncates long text with ellipsis", () => {
    expect(truncateText("hello", 10)).toBe("hello");
    expect(truncateText("hello world", 5)).toBe("hell…");
    expect(truncateText("a".repeat(100), 10)).toBe(`${"a".repeat(9)}…`);
  });

  test("normalizeTerminalSentence handles various prefixes", () => {
    expect(normalizeTerminalSentence("- bullet point")).toBe("bullet point");
    expect(normalizeTerminalSentence("> quoted text")).toBe("quoted text");
    expect(normalizeTerminalSentence("* emphasized")).toBe("emphasized");
    expect(normalizeTerminalSentence("## Heading")).toBe("Heading");
    expect(normalizeTerminalSentence("`code`")).toBe("code");
    // Note: **bold** regex requires exact match at start/end with no nested *
    expect(normalizeTerminalSentence("__underline__")).toBe("underline");
  });

  test("normalizeTerminalSentence strips status prefixes", () => {
    expect(normalizeTerminalSentence("success: completed")).toBe("completed");
    expect(normalizeTerminalSentence("failure: failed")).toBe("failed");
    expect(normalizeTerminalSentence("status: done")).toBe("done");
    expect(normalizeTerminalSentence("summary: brief")).toBe("brief");
    expect(normalizeTerminalSentence("result: output")).toBe("output");
  });

  test("normalizeTerminalSentence strips trailing punctuation", () => {
    expect(normalizeTerminalSentence("done.")).toBe("done");
    expect(normalizeTerminalSentence("completed!")).toBe("completed");
    expect(normalizeTerminalSentence("result;")).toBe("result");
    expect(normalizeTerminalSentence("output:")).toBe("output");
  });

  test("normalizeTerminalSentence handles empty and whitespace-only input", () => {
    expect(normalizeTerminalSentence("")).toBe("");
    expect(normalizeTerminalSentence("   ")).toBe("");
    expect(normalizeTerminalSentence("\t\n")).toBe("");
  });

  test("normalizeTerminalSentence truncates long sentences", () => {
    const longSentence = "a".repeat(150);
    const result = normalizeTerminalSentence(longSentence);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith("…")).toBe(true);
  });

  test("normalizeAndTruncate truncates long text", () => {
    const longText = "a".repeat(200);
    const result = normalizeAndTruncate(longText, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith("…")).toBe(true);
  });

  test("normalizeAndTruncate keeps short text unchanged", () => {
    const shortText = "hello world";
    expect(normalizeAndTruncate(shortText, 50)).toBe("hello world");
  });

  test("isStatusOnlySuccess detects success status", () => {
    expect(isStatusOnlySuccess("success")).toBe(true);
    expect(isStatusOnlySuccess("done")).toBe(true);
    expect(isStatusOnlySuccess("SUCCESS")).toBe(true);
    expect(isStatusOnlySuccess("DONE")).toBe(true);
    expect(isStatusOnlySuccess("failed")).toBe(false);
    expect(isStatusOnlySuccess("error occurred")).toBe(false);
  });

  test("isStatusOnlyFailure detects failure status", () => {
    expect(isStatusOnlyFailure("failure")).toBe(true);
    expect(isStatusOnlyFailure("failed")).toBe(true);
    expect(isStatusOnlyFailure("error")).toBe(true);
    expect(isStatusOnlyFailure("FAILURE")).toBe(true);
    expect(isStatusOnlyFailure("FAILED")).toBe(true);
    expect(isStatusOnlyFailure("ERROR")).toBe(true);
    expect(isStatusOnlyFailure("success")).toBe(false);
    expect(isStatusOnlyFailure("done")).toBe(false);
  });

  test("makeToolPreview creates preview for subagent tool", () => {
    const preview = makeToolPreview("subagent", {
      agent: "builder",
      task: "fix bugs",
    });
    expect(preview).toContain("subagent");
    expect(preview).toContain("builder");
  });

  test("makeToolPreview creates preview for non-subagent tool", () => {
    const preview = makeToolPreview("bash", { command: "ls -la" });
    expect(preview).toContain("bash");
    expect(preview).toContain("ls -la");
  });

  test("makeToolPreview handles missing arguments", () => {
    const preview = makeToolPreview("read", {});
    expect(preview).toContain("read");
  });
});

describe("utils.ts coverage gaps", () => {
  test("hasSubagentFailed detects various failure conditions", () => {
    expect(hasSubagentFailed({ exitCode: 1 } as unknown as SingleResult)).toBe(
      true,
    );
    expect(
      hasSubagentFailed({
        exitCode: 0,
        stopReason: "error",
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        stopReason: "aborted",
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        errorMessage: "something broke",
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "normal message" }],
            api: "fake",
            provider: "fake",
            model: "fake",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 0,
          },
          {
            role: "toolResult",
            isError: true,
            content: [{ type: "text", text: "error output" }],
          },
        ] as Message[],
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        stopReason: "stop",
        errorMessage: "",
        messages: [],
      } as unknown as SingleResult),
    ).toBe(false);
  });

  test("detectMessageError detects error in messages", () => {
    expect(detectMessageError([])).toBe(false);
    expect(
      detectMessageError([
        {
          role: "assistant",
          content: [{ type: "text", text: "normal message" }],
          api: "fake",
          provider: "fake",
          model: "fake",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      ] as Message[]),
    ).toBe(false);
    expect(
      detectMessageError([
        {
          role: "assistant",
          content: [{ type: "text", text: "normal message" }],
          api: "fake",
          provider: "fake",
          model: "fake",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        },
        {
          role: "toolResult",
          isError: true,
          content: [{ type: "text", text: "error output" }],
        },
      ] as Message[]),
    ).toBe(true);
  });

  test("getSubagentDepth returns depth from environment", () => {
    process.env.PI_SUBAGENT_DEPTH = "3";
    expect(getSubagentDepth()).toBe(3);
    delete process.env.PI_SUBAGENT_DEPTH;
    expect(getSubagentDepth()).toBe(0);
  });

  test("subagentDepthEnv returns depth environment variable", () => {
    process.env.PI_SUBAGENT_DEPTH = "5";
    const result = subagentDepthEnv();
    expect(result).toEqual({ PI_SUBAGENT_DEPTH: "6" });
    delete process.env.PI_SUBAGENT_DEPTH;
    const result2 = subagentDepthEnv();
    expect(result2).toEqual({ PI_SUBAGENT_DEPTH: "1" });
  });
});

describe("child-events.ts coverage gaps", () => {
  test("tryFirstResult handles non-object nested result", () => {
    const details = {
      results: [42], // Not an object
    };

    const line = JSON.stringify({
      type: "tool_execution_update",
      toolName: "bash",
      partialResult: { details },
    });

    const result = parseChildEventLine(line);
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      const event = result.event as {
        toolActivity: { toolName: string; inputSummary: string };
      };
      expect(event.toolActivity.toolName).toBe("bash");
      expect(event.toolActivity.inputSummary).toBe("bash");
    }
  });

  test("tryFirstResult handles null nested result", () => {
    const details = {
      results: [null],
    };

    const line = JSON.stringify({
      type: "tool_execution_update",
      toolName: "bash",
      partialResult: { details },
    });

    const result = parseChildEventLine(line);
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      const event = result.event as {
        toolActivity: { toolName: string; inputSummary: string };
      };
      expect(event.toolActivity.toolName).toBe("bash");
      expect(event.toolActivity.inputSummary).toBe("bash");
    }
  });
});

describe("process.ts coverage gaps", () => {
  test("makeEmitUpdate handles toolResultCompleted without toolActivity", async () => {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    });

    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );

    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
  });

  test("makeEmitUpdate preserves activity when toolResultCompleted arrives", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    ] as Message[];

    const result = {
      agent: "test",
      agentSource: "user" as const,
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

    const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

    // First call sets up activity
    emitUpdate();

    // Store initial activity
    const initialActivity = result.progress?.activeToolActivity;
    expect(initialActivity).toBeDefined();

    // Send toolResultCompleted without new toolActivity
    emitUpdate({ toolResultCompleted: true });

    // Activity should be preserved
    expect(result.progress?.activeToolActivity).toEqual(initialActivity);
    expect(result.progress?.toolResultCompleted).toBe(true);
  });
});

describe("jobs-command.ts coverage gaps", () => {
  test("jobsCommandHandler renders board with active and completed jobs", async () => {
    resetRunRegistry();
    resetProgressStore();

    const notices: string[] = [];
    const ctx = makeCommandContext((msg) => notices.push(msg));

    // Create some progress states
    const activeRid = "active-job";
    const completedRid = "completed-job";

    createProgressState(activeRid, "active-agent", "running task", "inst-1");
    createProgressState(
      completedRid,
      "completed-agent",
      "finished task",
      "inst-2",
    );

    // Register active job
    registerRunJob({
      requestId: activeRid,
      agentName: "active-agent",
      instanceName: "inst-1",
      controller: new AbortController(),
      startedAt: Date.now(),
    });

    // Finalize completed job
    finalizeProgressState(completedRid, "output");

    await jobsCommandHandler(ctx, "");

    expect(notices).toHaveLength(1);
    const output = notices[0] ?? "";
    expect(output).toContain("active-agent");
    expect(output).toContain("completed-agent");
    expect(output).toContain("ACTIVE (1)");
    expect(output).toContain("SUCCEEDED (1)");
  });

  test("jobsCommandHandler handles empty board", async () => {
    resetRunRegistry();
    resetProgressStore();

    const notices: string[] = [];
    const ctx = makeCommandContext((msg) => notices.push(msg));

    await jobsCommandHandler(ctx, "");

    expect(notices).toEqual(["No /run jobs in this session."]);
  });
});

describe("utils.ts coverage gaps", () => {
  test("writePromptToTempFile creates temp file with sanitized agent name", async () => {
    const prompt = "Test prompt content";
    const result = await writePromptToTempFile("test-agent", prompt);

    expect(result.dir).toBeDefined();
    expect(result.filePath).toBeDefined();
    expect(result.filePath).toContain("prompt-test-agent.md");

    // Verify file was created with correct content
    const content = await fs.promises.readFile(result.filePath, "utf-8");
    expect(content).toBe(prompt);

    // Verify file permissions
    const stat = await fs.promises.stat(result.filePath);
    const mode = (stat.mode & 0o777).toString(8);
    expect(mode).toBe("600");

    // Cleanup
    await fs.promises.unlink(result.filePath);
    await fs.promises.rmdir(result.dir);
  });

  test("writePromptToTempFile sanitizes special characters in agent name", async () => {
    const prompt = "Test prompt";
    const result = await writePromptToTempFile(
      "agent with spaces!@#$%",
      prompt,
    );

    expect(result.filePath).toContain("prompt-agent_with_spaces_.md");

    // Cleanup
    await fs.promises.unlink(result.filePath);
    await fs.promises.rmdir(result.dir);
  });

  test("getPiInvocation returns current script when argv[1] exists", () => {
    const originalArgv1 = process.argv[1] ?? "";
    const originalExecPath = process.execPath;

    try {
      // Create a temporary file to simulate existing script
      const tmpFile = path.join(os.tmpdir(), "test-pi-script");
      fs.writeFileSync(tmpFile, "#!/bin/sh\n");
      process.argv[1] = tmpFile;
      process.execPath = "/usr/bin/bun";

      const result = getPiInvocation(["--mode", "json"]);
      expect(result.command).toBe("/usr/bin/bun");
      expect(result.args).toEqual([tmpFile, "--mode", "json"]);

      // Cleanup
      fs.unlinkSync(tmpFile);
    } finally {
      process.argv[1] = originalArgv1;
      process.execPath = originalExecPath;
    }
  });

  test("getPiInvocation returns pi command when script doesn't exist", () => {
    const originalArgv1 = process.argv[1] ?? "";
    const originalExecPath = process.execPath;

    try {
      process.argv[1] = "/non/existent/pi";
      process.execPath = "/usr/bin/bun";

      const result = getPiInvocation(["--mode", "json"]);
      expect(result.command).toBe("pi");
      expect(result.args).toEqual(["--mode", "json"]);
    } finally {
      process.argv[1] = originalArgv1;
      process.execPath = originalExecPath;
    }
  });

  test("getPiInvocation returns exec path for non-generic runtimes", () => {
    const originalArgv1 = process.argv[1] ?? "";
    const originalExecPath = process.execPath;

    try {
      process.argv[1] = "/non/existent/pi";
      process.execPath = "/usr/bin/custom-runtime";

      const result = getPiInvocation(["--mode", "json"]);
      expect(result.command).toBe("/usr/bin/custom-runtime");
      expect(result.args).toEqual(["--mode", "json"]);
    } finally {
      process.argv[1] = originalArgv1;
      process.execPath = originalExecPath;
    }
  });

  test("getPiInvocation handles .exe extension on Windows", () => {
    const originalArgv1 = process.argv[1] ?? "";
    const originalExecPath = process.execPath;

    try {
      process.argv[1] = "/non/existent/pi";
      process.execPath = "/usr/bin/bun.exe";

      const result = getPiInvocation(["--mode", "json"]);
      expect(result.command).toBe("pi");
      expect(result.args).toEqual(["--mode", "json"]);
    } finally {
      process.argv[1] = originalArgv1;
      process.execPath = originalExecPath;
    }
  });

  test("resolveAgentSkillArgs returns error for missing skills", async () => {
    const result = await resolveAgentSkillArgs("/tmp", ["nonexistent-skill"]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Unknown skill");
      expect(result.error).toContain("nonexistent-skill");
    }
  });

  test("resolveAgentSkillArgs returns empty args for empty skill list", async () => {
    const result = await resolveAgentSkillArgs("/tmp", []);
    expect(result).toEqual({ args: [] });
  });
});

describe("termination.ts coverage gaps", () => {
  test("terminateChildProcess handles child without PID", async () => {
    const { EventEmitter } = await import("node:events");
    const proc =
      new EventEmitter() as unknown as import("node:child_process").ChildProcess;
    // proc.pid is undefined by default

    const metadata = await terminateChildProcess(proc);
    expect(metadata.terminationSignal).toBeUndefined();
    expect(metadata.target).toBe("direct");
  });

  describe("live-PID process group", () => {
    test("terminateChildProcess handles tree termination with process group", async () => {
      const { spawn } = await import("node:child_process");
      const proc = spawn("sleep", ["10"], {
        stdio: "ignore",
        detached: true,
      });

      const metadata = await terminateChildProcess(proc, {
        tree: true,
        platform: "linux",
        processTreeDetached: true,
      });

      expect(metadata.target).toBe("tree");
      expect(metadata.processTreeKilled).toBe(true);
      expect(metadata.terminationSignal).toBe("SIGTERM");
    });
  });

  test("acquireChildSleepInhibitor returns no-op handle for invalid PID", async () => {
    const adapter: SleepInhibitorAdapter = {
      acquire: () => {
        throw new Error("should not be called");
      },
    };

    const handle = await acquireChildSleepInhibitor(undefined, adapter);
    await handle.release(); // Should not throw

    const handle2 = await acquireChildSleepInhibitor(Infinity, adapter);
    await handle2.release();

    const handle3 = await acquireChildSleepInhibitor(NaN, adapter);
    await handle3.release();
  });

  test("acquireChildSleepInhibitor handles adapter acquire failure", async () => {
    const adapter: SleepInhibitorAdapter = {
      acquire: () => {
        throw new Error("acquire failed");
      },
    };

    const handle = await acquireChildSleepInhibitor(123, adapter);
    await handle.release(); // Should not throw
  });

  test("acquireChildSleepInhibitor handles adapter returning non-object", async () => {
    const adapter: SleepInhibitorAdapter = {
      acquire: () => "not an object",
    };

    const handle = await acquireChildSleepInhibitor(123, adapter);
    await handle.release(); // Should not throw
  });

  test("acquireChildSleepInhibitor handles supported() returning false", async () => {
    const adapter: SleepInhibitorAdapter = {
      supported: () => false,
      acquire: () => {
        throw new Error("should not be called");
      },
    };

    const handle = await acquireChildSleepInhibitor(123, adapter);
    await handle.release(); // Should not throw
  });

  test("acquireChildSleepInhibitor handles supported() returning Promise false", async () => {
    const adapter: SleepInhibitorAdapter = {
      supported: async () => false,
      acquire: () => {
        throw new Error("should not be called");
      },
    };

    const handle = await acquireChildSleepInhibitor(123, adapter);
    await handle.release(); // Should not throw
  });
});

describe("process.ts coverage gaps", () => {
  test("makeEmitUpdate merges tool activity with same tool name", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "subagent",
            arguments: { agent: "builder", task: "fix bugs" },
          },
        ],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    ] as Message[];

    const result = {
      agent: "test",
      agentSource: "user" as const,
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
    } as import("../src/shared/types.js").SingleResult & {
      messages: Message[];
    };

    const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

    // First call to set up initial activity
    emitUpdate();
    const initialActivity = result.progress?.activeToolActivity;
    expect(initialActivity).toBeDefined();

    // Merge with same tool name but richer inputSummary
    emitUpdate({
      toolActivity: {
        toolName: "subagent",
        inputSummary: "bash: scan src",
      },
    });

    // Should prefer incoming inputSummary since it's richer than toolName
    expect(result.progress?.activeToolActivity?.inputSummary).toBe(
      "bash: scan src",
    );
  });

  test("makeEmitUpdate merges tool activity with different tool name", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "subagent",
            arguments: { agent: "builder", task: "fix bugs" },
          },
        ],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    ] as Message[];

    const result = {
      agent: "test",
      agentSource: "user" as const,
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
    } as import("../src/shared/types.js").SingleResult & {
      messages: Message[];
    };

    const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

    // First call to set up initial activity
    emitUpdate();
    expect(result.progress?.activeToolActivity).toBeDefined();

    // Merge with different tool name - should replace entirely
    emitUpdate({
      toolActivity: {
        toolName: "bash",
        inputSummary: "bash: ls",
      },
    });

    expect(result.progress?.activeToolActivity?.toolName).toBe("bash");
    expect(result.progress?.activeToolActivity?.inputSummary).toBe("bash: ls");
  });

  test("makeEmitUpdate handles toolResultCompleted with existing activity", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    ] as Message[];

    const result = {
      agent: "test",
      agentSource: "user" as const,
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
    } as import("../src/shared/types.js").SingleResult & {
      messages: Message[];
    };

    const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

    // First call to set up activity
    emitUpdate();
    const initialActivity = result.progress?.activeToolActivity;
    expect(initialActivity).toBeDefined();

    // Send toolResultCompleted - should preserve activity
    emitUpdate({ toolResultCompleted: true });

    expect(result.progress?.activeToolActivity).toEqual(initialActivity);
    expect(result.progress?.toolResultCompleted).toBe(true);
  });

  test("makeEmitUpdate handles toolResultCompleted without existing activity", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    ] as Message[];

    const result = {
      agent: "test",
      agentSource: "user" as const,
      task: "task",
      exitCode: 0,
      finalOutput: "done",
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
    } as import("../src/shared/types.js").SingleResult & {
      messages: Message[];
    };

    const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

    // First call - no activity
    emitUpdate();
    expect(result.progress?.activeToolActivity).toBeUndefined();

    // Send toolResultCompleted - should set flag
    emitUpdate({ toolResultCompleted: true });
    expect(result.progress?.toolResultCompleted).toBe(true);
  });

  test("makeEmitUpdate handles merge with child activity", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "subagent",
            arguments: { agent: "builder", task: "fix bugs" },
          },
        ],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    ] as Message[];

    const result = {
      agent: "test",
      agentSource: "user" as const,
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
    } as import("../src/shared/types.js").SingleResult & {
      messages: Message[];
    };

    const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

    // First call to set up activity
    emitUpdate();
    expect(result.progress?.activeToolActivity).toBeDefined();

    // Merge with child activity
    emitUpdate({
      toolActivity: {
        toolName: "subagent",
        inputSummary: "bash: scan src",
        child: {
          toolName: "bash",
          inputSummary: "bash: scan src",
        },
      },
    });

    expect(result.progress?.activeToolActivity?.child).toEqual({
      toolName: "bash",
      inputSummary: "bash: scan src",
    });
  });

  test("makeEmitUpdate handles merge with instanceName", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "subagent",
            arguments: { agent: "builder", task: "fix bugs" },
          },
        ],
        api: "fake",
        provider: "fake",
        model: "fake",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    ] as Message[];

    const result = {
      agent: "test",
      agentSource: "user" as const,
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
    } as import("../src/shared/types.js").SingleResult & {
      messages: Message[];
    };

    const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);

    // First call to set up activity
    emitUpdate();
    expect(result.progress?.activeToolActivity).toBeDefined();

    // Merge with instanceName
    emitUpdate({
      toolActivity: {
        toolName: "subagent",
        inputSummary: "subagent",
        instanceName: "able-falcon",
      },
    });

    expect(result.progress?.activeToolActivity?.instanceName).toBe(
      "able-falcon",
    );
  });
});
