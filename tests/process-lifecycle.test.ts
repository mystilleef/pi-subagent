import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  getAgentEndTimeoutExitCode,
  hasCompletedAgentOutput,
  runSingleAgent,
} from "../src/child/process.js";
import type { SingleResult } from "../src/shared/types.js";
import { TOOL_RESULT_FAILED_MESSAGE } from "../src/shared/types.js";
import {
  createAgentEndTimeoutScenarioRunner,
  emitAgentEnd,
  emitMessageEnd,
  hangAgent,
  makeAssistantMessage,
  makeRuntimeResult,
  makeSubagentDetails,
  setupHooks,
  setupTest,
} from "./helpers.js";

setupHooks();

const runAgentEndTimeoutScenario = createAgentEndTimeoutScenarioRunner();

test("runSingleAgent reports unknown agents with available names", async () => {
  const { result } = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "missing",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.agentSource).toBe("unknown");
  expect(result.stderr).toBe(
    'Unknown agent: "missing". Available agents: "hang".',
  );
});

test("runSingleAgent reports default depth limit with effective max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "5";
  const { result } = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("depth 5/5");
});

test("runSingleAgent uses env-configured max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "4";
  process.env.PI_SUBAGENT_MAX_DEPTH = "5";
  const { cwd } = await setupTest();
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

test("runSingleAgent reports clamped env max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "10";
  process.env.PI_SUBAGENT_MAX_DEPTH = "99";
  const { result } = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("depth 10/10");
});

test.each([
  {
    name: "runSingleAgent truncates stderr to env-configured byte cap",
    maxStderrBytes: "7",
    piScript: `#!/bin/sh
printf 'abcdefghij' >&2
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
exit 0
`,
    expectedStderr: "abcdefg",
  },
  {
    name: "runSingleAgent keeps empty stderr under configured byte cap",
    maxStderrBytes: "1",
    piScript: `#!/bin/sh
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
exit 0
`,
    expectedStderr: "",
  },
])("$name", async (row) => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = row.maxStderrBytes;
  const { cwd } = await setupTest({
    piScript: row.piScript,
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
  expect(result.stderr).toBe(row.expectedStderr);
});

test("runSingleAgent truncates multibyte stderr at valid UTF-8 byte boundaries", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "7";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'a😀b中c' >&2
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
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
  expect(result.stderr).toBe("a😀b");
  expect(Buffer.byteLength(result.stderr, "utf-8")).toBeLessThanOrEqual(7);
  expect(result.stderr).not.toContain("�");
});

test("runSingleAgent caps spawn error stderr by configured byte limit", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "6";
  const { cwd } = await setupTest();
  const originalArgv1 = process.argv[1];
  const originalExecPath = process.execPath;
  process.argv[1] = "/non/existent/pi";
  process.execPath = "/non/existent/pi_exec";
  try {
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
    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stderr, "utf-8")).toBeLessThanOrEqual(6);
    expect(result.stderr).not.toContain("�");
  } finally {
    if (originalArgv1 !== undefined) process.argv[1] = originalArgv1;
    process.execPath = originalExecPath;
  }
});

test("runSingleAgent preserves default stdout drain after agent_end", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitAgentEnd([])}
sleep 0.05
${emitMessageEnd(makeAssistantMessage("done after agent_end"))}
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
  expect(result.finalOutput).toBe("done after agent_end");
});

test("runSingleAgent honors explicit lower agent-end grace", async () => {
  const { result, elapsedMs } = await runAgentEndTimeoutScenario();
  expect(elapsedMs).toBeLessThan(500);
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

test("runSingleAgent cancels cleanly with nonstandard abort reason", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  controller.abort(null);
  const nonStandardOutcome = await promise;
  expect(nonStandardOutcome.kind).toBe("aborted");
});

test("runSingleAgent agent-end timeout with empty output returns exit code 1", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
${emitAgentEnd([])}
sleep 10 &
wait $!
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
  expect(result.exitCode).toBe(1);
  expect(result.finalOutput).toBe("");
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

test("runSingleAgent treats earlier assistant text as completed output after agent-end timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
${emitMessageEnd(makeAssistantMessage("earlier done"))}
${emitMessageEnd(makeAssistantMessage("bash pwd", { content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "pwd" } }] }))}
${emitAgentEnd([])}
sleep 10 &
wait $!
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
  expect(result.finalOutput).toBe("earlier done");
  expect(result.messages).toHaveLength(2);
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

describe("agent_end message snapshot rebuild", () => {
  async function runSnapshotScript(lines: string[]): Promise<SingleResult> {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
${lines.join("\n")}
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
    return result;
  }

  test("non-empty agent_end messages restore missed final streamed message", async () => {
    const streamed = makeAssistantMessage("streamed", {
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { total: 0.1 },
      },
    });
    const missed = makeAssistantMessage("missed final", {
      usage: {
        input: 3,
        output: 4,
        cacheRead: 1,
        cacheWrite: 2,
        totalTokens: 7,
        cost: { total: 0.2 },
      },
      stopReason: "length",
    });
    const result = await runSnapshotScript([
      emitMessageEnd(streamed),
      emitAgentEnd([streamed, missed]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("missed final");
    expect(result.messages).toHaveLength(2);
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(4);
    expect(result.usage.output).toBe(6);
    expect(result.usage.cacheRead).toBe(1);
    expect(result.usage.cacheWrite).toBe(2);
    expect(result.usage.cost).toBeCloseTo(0.3);
    expect(result.stopReason).toBe("length");
  });

  test("empty agent_end messages preserve streamed state", async () => {
    const streamed = makeAssistantMessage("streamed only", {
      usage: {
        input: 5,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { total: 0.4 },
      },
      stopReason: "stop",
    });
    const result = await runSnapshotScript([
      emitMessageEnd(streamed),
      emitAgentEnd([]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("streamed only");
    expect(result.messages).toHaveLength(1);
    expect(result.usage.input).toBe(5);
    expect(result.usage.output).toBe(6);
    expect(result.usage.cost).toBe(0.4);
    expect(result.stopReason).toBe("stop");
  });

  test("snapshot rebuild recomputes derived result fields", async () => {
    const stale = makeAssistantMessage("stale", {
      usage: {
        input: 100,
        output: 200,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 300,
        cost: { total: 9 },
      },
      stopReason: "length",
      errorMessage: "stale error",
    });
    const authoritative = makeAssistantMessage("authoritative", {
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 6,
        cost: { total: 0.7 },
      },
      stopReason: "error",
      errorMessage: "final error",
    });
    const result = await runSnapshotScript([
      emitMessageEnd(stale),
      emitAgentEnd([authoritative]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("authoritative");
    expect(result.messages).toHaveLength(1);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(2);
    expect(result.usage.output).toBe(3);
    expect(result.usage.cacheRead).toBe(4);
    expect(result.usage.cacheWrite).toBe(5);
    expect(result.usage.cost).toBe(0.7);
    expect(result.usage.contextTokens).toBe(6);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("final error");
  });
});

test("pre-aborted signal triggers immediate termination", async () => {
  const piScript = `#!/bin/sh
sleep 10
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const controller = new AbortController();
  controller.abort("pre-aborted");
  const outcome = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(outcome.kind).toBe("aborted");
  expect(outcome.result.termination).toBeDefined();
  expect(outcome.result.termination?.cancelReason).toBe("pre-aborted");
});

test.each([
  {
    name: "runSingleAgent prefers toolResult details.outcome over assistant arguments.outcome",
    piScript: `#!/bin/sh
${emitMessageEnd({ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "complete", arguments: { outcome: "Assistant outcome" } }] })}
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Tool outcome beats assistant"}}}'
${emitAgentEnd([])}
exit 0
`,
    expectedOutcome: "Assistant outcome",
  },
  {
    name: "runSingleAgent handles multiple complete calls, newer invalid/blank calls do not block older valid outcomes",
    piScript: `#!/bin/sh
${emitMessageEnd({ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "complete", arguments: { outcome: "First valid" } }] })}
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"First valid"}}}'
${emitMessageEnd({ role: "assistant", content: [{ type: "toolCall", id: "tc-2", name: "complete", arguments: { outcome: "   " } }] })}
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-2","details":{"outcome":"   "}}}'
${emitAgentEnd([])}
exit 0
`,
    expectedOutcome: "First valid",
  },
])("$name", async (row) => {
  const piScript = row.piScript;
  const { cwd } = await setupTest({ piScript });
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
  expect(result.outcome).toBe(row.expectedOutcome);
});

test("runSingleAgent ignores blank or malformed outcomes", async () => {
  const piScript = `#!/bin/sh
${emitMessageEnd({ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "complete", arguments: { outcome: "   " } }] })}
${emitAgentEnd([])}
exit 0
`;
  const { cwd } = await setupTest({ piScript });
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
  expect(result.outcome).toBeUndefined();
});

test("runSingleAgent ignores outcome on failed complete call", async () => {
  const piScript = `#!/bin/sh
${emitMessageEnd({ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "complete", arguments: { outcome: "Should be ignored" } }] })}
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true}}'
${emitAgentEnd([])}
exit 0
`;
  const { cwd } = await setupTest({ piScript });
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
  expect(result.outcome).toBe("Should be ignored");
});

test("runSingleAgent preserves outcome during agent-end timeout with no assistant text", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
${emitMessageEnd({ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "complete", arguments: { outcome: "Timed out outcome" } }] })}
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Timed out outcome"}}}'
${emitAgentEnd([])}
sleep 10 &
wait $!
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
  expect(result.outcome).toBe("Timed out outcome");
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

test("runSingleAgent deletes extracted outcome when child exits non-zero", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd({ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "complete", arguments: { outcome: "Should be deleted" } }] })}
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Should be deleted"}}}'
${emitAgentEnd([])}
exit 1
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
  expect(result.exitCode).toBe(1);
  expect(result.outcome).toBeUndefined();
});

test("runSingleAgent deletes extracted outcome when host aborts after outcome", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
${emitMessageEnd({ role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "complete", arguments: { outcome: "Aborted outcome" } }] })}
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Aborted outcome"}}}'
${emitAgentEnd([])}
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  controller.abort("host abort after outcome");
  const outcome = await promise;
  expect(outcome.kind).toBe("aborted");
  expect(outcome.result.outcome).toBeUndefined();
  expect(outcome.result.termination?.cancelReason).toBe(
    "host abort after outcome",
  );
});

describe("process cleanup", () => {
  test("runSingleAgent destroys idle streams when the child exits with an inherited open pipe", async () => {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
(sleep 0.5 &)
exit 0
`,
    });
    // Fixture teardown reaps the sleeper with the child's process group.
    const startedAt = Date.now();
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
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
  });
});

test("runSingleAgent strips leading Terminated lines from stderr on agent_end_timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'Terminated\\nother stderr\\n' >&2
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
sleep 10 &
wait $!
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
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
  expect(result.stderr).not.toContain("Terminated");
  expect(result.stderr).toContain("other stderr");
});

test("runSingleAgent sets errorMessage when a toolResult error occurs without a complete outcome", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(makeAssistantMessage("bash false", { content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "false" } }] }))}
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true,"content":[{"type":"text","text":"error"}]}}'
${emitAgentEnd([])}
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
  expect(result.outcome).toBeUndefined();
  expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
});

test("runSingleAgent preserves complete outcome when complete toolResult errors", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(makeAssistantMessage("completed despite error", { content: [{ type: "toolCall", id: "tc-1", name: "complete", arguments: { outcome: "Completed despite error" } }] }))}
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true,"details":{"outcome":"Completed despite error"}}}'
${emitAgentEnd([])}
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
  expect(result.outcome).toBe("Completed despite error");
  expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
});

test("runSingleAgent extracts complete outcome from agent_end snapshot despite toolResult error", async () => {
  const assistantMsg = makeAssistantMessage("used complete", {
    content: [
      {
        type: "toolCall",
        id: "tc-complete",
        name: "complete",
        arguments: { outcome: "Snapshot succeeded" },
      },
    ],
  });
  const toolError = {
    role: "toolResult",
    toolCallId: "tc-complete",
    isError: true,
    content: [{ type: "text", text: "complete toolResult error" }],
  } as Record<string, unknown>;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(assistantMsg)}
${emitAgentEnd([assistantMsg, toolError])}
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
  expect(result.outcome).toBe("Snapshot succeeded");
  expect(result.messages).toHaveLength(2);
});

test("runSingleAgent rebuilds agent_end snapshot and propagates toolResult error", async () => {
  const assistant = makeAssistantMessage("used tool", {
    content: [
      {
        type: "toolCall",
        id: "tc-1",
        name: "bash",
        arguments: { command: "false" },
      },
    ],
  });
  const toolError = {
    role: "toolResult",
    toolCallId: "tc-1",
    isError: true,
    content: [{ type: "text", text: "error" }],
  } as Record<string, unknown>;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(assistant)}
${emitAgentEnd([assistant, toolError])}
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
  expect(result.messages).toHaveLength(2);
  expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
  expect(result.outcome).toBeUndefined();
});

describe("hasCompletedAgentOutput", () => {
  test("returns true when finalOutput has non-whitespace content", () => {
    const result = makeRuntimeResult({
      finalOutput: "some output",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result)).toBe(true);
  });

  test("returns true when finalOutput is whitespace-only but outcome has content", () => {
    const result = makeRuntimeResult({
      finalOutput: "   \n  ",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result, "completed successfully")).toBe(
      true,
    );
  });

  test("returns true when both finalOutput and outcome are empty but messages contain final output text", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "real output" }],
        } as unknown as Message,
      ],
    });
    expect(hasCompletedAgentOutput(result)).toBe(true);
  });

  test("returns false when finalOutput is empty and outcome is undefined", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result)).toBe(false);
  });

  test("returns false when finalOutput is only whitespace and outcome is empty", () => {
    const result = makeRuntimeResult({
      finalOutput: "   ",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result, "   ")).toBe(false);
  });

  test("returns true when outcome has content regardless of finalOutput state", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result, "all done")).toBe(true);
  });

  test("returns false when messages exist but have no assistant text", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        } as unknown as Message,
      ],
    });
    expect(hasCompletedAgentOutput(result)).toBe(false);
  });
});

describe("getAgentEndTimeoutExitCode", () => {
  test("returns undefined when termination cancelReason is not agent_end_timeout", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "user_cancelled",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when termination is absent", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when spawnError is present", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    const spawnError = new Error("spawn failed");
    expect(
      getAgentEndTimeoutExitCode(result, spawnError, undefined),
    ).toBeUndefined();
  });

  test.each([
    { name: "returns undefined when stopReason is error", stopReason: "error" },
    {
      name: "returns undefined when stopReason is aborted",
      stopReason: "aborted",
    },
  ])("$name", (row) => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      stopReason: row.stopReason,
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when errorMessage has non-whitespace content", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      errorMessage: "something went wrong",
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns 1 when errorMessage is whitespace-only and no output", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      errorMessage: "   ",
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(1);
  });

  test.each([
    {
      name: "returns 0 when agent completed output and agent_end_timeout",
      finalOutput: "task completed",
      expectedExitCode: 0,
    },
    {
      name: "returns 1 when agent did not complete output and agent_end_timeout",
      finalOutput: "",
      expectedExitCode: 1,
    },
  ])("$name", (row) => {
    const result = makeRuntimeResult({
      finalOutput: row.finalOutput,
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(
      row.expectedExitCode,
    );
  });

  test("returns 0 when outcome provides content for agent_end_timeout", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, "done")).toBe(0);
  });

  test("returns 0 when messages contain output for agent_end_timeout with no finalOutput", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "result text" }],
        } as unknown as Message,
      ],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(0);
  });
});
