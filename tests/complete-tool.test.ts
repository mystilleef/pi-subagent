import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { AgentConfig } from "../src/agent/agents.js";
import registerExtension, {
  completeParams,
  completeTool,
} from "../src/child/complete-extension.js";
import { runSingleAgent } from "../src/child/process.js";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import { normalizeTerminalSentence } from "../src/output/normalize.js";
import { summarizeFeedbackUiFinalOutput } from "../src/output/summary.js";
import {
  createProgressState,
  finalizeProgressState,
  getProgressState,
} from "../src/progress/progress-state.js";
import {
  getFeedbackSummaryText,
  sanitizeDetailsForDisplay,
  sanitizeResultDetails,
} from "../src/progress/result-details.js";
import {
  hangAgent,
  makeSubagentDetails,
  setupHooks,
  setupTest,
} from "./helpers.js";

setupHooks();

test("SUBAGENT_RESULT_CONTRACT includes completion and result preservation instructions", () => {
  expect(SUBAGENT_RESULT_CONTRACT).toContain("complete tool");
  expect(SUBAGENT_RESULT_CONTRACT).toContain(
    "**NEVER** wrap the entire result in one code block.",
  );
  expect(SUBAGENT_RESULT_CONTRACT).toContain(
    "Emit result to the calling agent without commentary.",
  );
});

test("completeTool parameters require outcome string", () => {
  expect(completeTool.name).toBe("complete");
  expect(completeTool.label).toBe("Complete");
  expect(completeTool.description).toBeDefined();
});

test("completeParams is exported and equals completeTool.parameters by reference", () => {
  expect(completeParams).toBe(completeTool.parameters);
});

test("completeTool parameters reject missing, non-string, empty, and whitespace-only outcomes", () => {
  const check = (input: unknown) => Value.Check(completeParams, input);

  // Valid outcomes
  expect(check({ outcome: "Successfully done" })).toBe(true);
  expect(check({ outcome: "a" })).toBe(true);
  expect(check({ outcome: "Valid string with spaces" })).toBe(true);

  // Invalid outcomes
  expect(check({})).toBe(false); // missing
  expect(check({ outcome: 123 })).toBe(false); // non-string (number)
  expect(check({ outcome: true })).toBe(false); // non-string (boolean)
  expect(check({ outcome: "" })).toBe(false); // empty
  expect(check({ outcome: "   " })).toBe(false); // whitespace-only
  expect(check({ outcome: "\n" })).toBe(false); // whitespace-only with newline
  expect(check({ outcome: " \n " })).toBe(false); // whitespace-only multi-line
});

test("completeTool execute returns correct payload and terminate: true", async () => {
  const result = await completeTool.execute(
    "call-1",
    { outcome: "Successfully done" },
    new AbortController().signal,
    undefined,
    {} as unknown as ExtensionContext,
  );
  expect(result.terminate).toBe(true);
  expect(result.details?.outcome).toBe("Successfully done");
  const content = result.content?.[0] as
    | { type: string; text?: string }
    | undefined;
  expect(content?.type).toBe("text");
  expect(content?.text).toBe("Successfully done");
});

describe("complete-extension default export", () => {
  test("default export is a function registering the complete tool", () => {
    let registeredTool: unknown = null;
    const mockPi = {
      registerTool: (tool: unknown) => {
        registeredTool = tool;
      },
    };
    registerExtension(mockPi as ExtensionAPI);
    expect(registeredTool).toBe(completeTool);
  });
});

describe("allowlist merging and duplicate complete entries", () => {
  function makeModelAgent(overrides: Partial<AgentConfig>): AgentConfig {
    return { ...hangAgent, ...overrides };
  }

  async function captureRunSingleAgentArgs(
    agent: AgentConfig,
  ): Promise<string[]> {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
printf '%s\n' "$@" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    });
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    return fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
  }

  function flagValues(args: string[], flag: string): string[] {
    return args.flatMap((arg, index) =>
      arg === flag ? [args[index + 1] ?? ""] : [],
    );
  }

  test("injects complete extension and handles duplicate tools list elegantly", async () => {
    const agentWithComplete = makeModelAgent({
      tools: ["read", "complete", "write"],
    });
    const args = await captureRunSingleAgentArgs(agentWithComplete);
    expect(args).toContain("--extension");
    const extPaths = flagValues(args, "--extension");
    expect(extPaths.length).toBe(1);
    expect(extPaths[0] ?? "").toContain("complete-extension");
    expect(args).toContain("--tools");
    const toolsList = flagValues(args, "--tools")[0] ?? "";
    const tools = toolsList.split(",");
    expect(tools.filter((t) => t === "complete").length).toBe(1);
    expect(tools).toEqual(["read", "complete", "write"]);
  });
});

describe("JSON Event Fixtures / Outcome Extraction", () => {
  test("extracts outcome from toolResult details", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"A beautiful outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"A beautiful outcome"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
    expect(result.outcome).toBe("A beautiful outcome");
  });

  test("extracts outcome from call arguments without requiring toolResult", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Assistant outcome"}}]}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
    expect(result.outcome).toBe("Assistant outcome");
  });

  test("extracts tool-only completion (no assistant companion text message)", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-complete-only","name":"complete","arguments":{"outcome":"Tool-only outcome text"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-complete-only","details":{"outcome":"Tool-only outcome text"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
    expect(result.outcome).toBe("Tool-only outcome text");
    expect(result.finalOutput).toBe("");
  });

  test("extracts outcome and preserves raw finalOutput (assistant companion text message present)", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"My helper response text."},{"type":"toolCall","id":"tc-complete-asst","name":"complete","arguments":{"outcome":"Companion outcome text"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-complete-asst","details":{"outcome":"Companion outcome text"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
    expect(result.outcome).toBe("Companion outcome text");
    expect(result.finalOutput).toBe("My helper response text.");
  });

  test("handles multiple complete calls - latest valid wins", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"First outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"First outcome"}}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-2","name":"complete","arguments":{"outcome":"Second outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-2","details":{"outcome":"Second outcome"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
    expect(result.outcome).toBe("Second outcome");
  });

  test("handles blank/non-string outcomes by ignoring them", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"   "}}]}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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

  test("extracts outcome from call arguments even when complete toolResult is isError", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Errored outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true,"details":{"outcome":"Errored outcome"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
    expect(result.outcome).toBe("Errored outcome");
  });

  test("latest successful blank/missing details uses same-call valid arguments instead of older outcomes", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"First outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"First outcome"}}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-2","name":"complete","arguments":{"outcome":"Second outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-2","details":{"outcome":""}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
    expect(result.outcome).toBe("Second outcome");
  });

  test("returns latest complete call arguments even when toolResult is error", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"First valid outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"First valid outcome"}}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-2","name":"complete","arguments":{"outcome":"Second errored outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-2","isError":true,"details":{"outcome":"Second errored outcome"}}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done with errored complete"}]}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
    expect(result.outcome).toBe("Second errored outcome");
  });
});

describe("Progress & Feedback Preference and Normalization", () => {
  test("finalizeProgressState prefers outcome parameter when supplied", () => {
    createProgressState("req-pref-1", "agent-x", "task-x");
    finalizeProgressState(
      "req-pref-1",
      "some final output text",
      "Awesome outcome text",
    );
    expect(getProgressState("req-pref-1")?.finalOutput).toBe(
      "awesome outcome text",
    );
  });

  test("finalizeProgressState falls back to finalOutput when outcome parameter is absent or blank", () => {
    createProgressState("req-pref-2", "agent-x", "task-x");
    finalizeProgressState("req-pref-2", "Outcome: Fallback parsed text", "");
    expect(getProgressState("req-pref-2")?.finalOutput).toBe(
      "outcome: fallback parsed text",
    );
    createProgressState("req-pref-3", "agent-x", "task-x");
    finalizeProgressState(
      "req-pref-3",
      "Outcome: Fallback parsed text",
      undefined,
    );
    expect(getProgressState("req-pref-3")?.finalOutput).toBe(
      "outcome: fallback parsed text",
    );
  });

  test("getFeedbackSummaryText prefers outcome inside SingleResult", () => {
    const toolResult = {
      content: [{ type: "text", text: "raw text content" }],
      details: {
        mode: "single",
        agentScope: "project",
        projectAgentsDir: null,
        results: [
          {
            agent: "tester",
            agentSource: "project",
            task: "check",
            exitCode: 0,
            finalOutput: "raw final output",
            outcome: "Typed outcome has high precedence!",
            stderr: "",
          },
        ],
      },
    };
    const summary = getFeedbackSummaryText(
      toolResult as unknown as Parameters<typeof getFeedbackSummaryText>[0],
    );
    expect(summary).toBe("typed outcome has high precedence");
  });

  test("summarizeFeedbackUiFinalOutput prefers explicit outcome first", () => {
    expect(
      summarizeFeedbackUiFinalOutput(
        "some raw final output",
        "My custom outcome text",
      ),
    ).toBe("my custom outcome text");
  });

  test("normalizeTerminalSentence preserves outcome: label but strips others", () => {
    expect(normalizeTerminalSentence("outcome: success")).toBe(
      "outcome: success",
    );
    expect(normalizeTerminalSentence("error: file not found")).toBe(
      "file not found",
    );
  });

  test("finalizeProgressState truncates long outcomes to 120 characters", () => {
    createProgressState("req-pref-long", "agent-x", "task-x");
    const longOutcome = "A".repeat(150);
    finalizeProgressState(
      "req-pref-long",
      "some final output text",
      longOutcome,
    );
    expect(getProgressState("req-pref-long")?.finalOutput).toBe(
      `${"a".repeat(119)}…`,
    );
  });

  test("summarizeFeedbackUiFinalOutput truncates long outcomes to 120 characters", () => {
    const longOutcome = "B".repeat(150);
    const summary = summarizeFeedbackUiFinalOutput(
      "some raw final output",
      longOutcome,
    );
    expect(summary).toBe(`${"b".repeat(119)}…`);
  });

  test("finalizeProgressState falls back to finalOutput when outcome is whitespace-only", () => {
    createProgressState("req-pref-ws", "agent-x", "task-x");
    finalizeProgressState("req-pref-ws", "Fallback parsed text", "   \n  ");
    expect(getProgressState("req-pref-ws")?.finalOutput).toBe(
      "fallback parsed text",
    );
  });

  test("getFeedbackSummaryText falls back to finalOutput when outcome is whitespace-only", () => {
    const toolResult = {
      content: [{ type: "text", text: "raw text content" }],
      details: {
        mode: "single",
        agentScope: "project",
        projectAgentsDir: null,
        results: [
          {
            agent: "tester",
            agentSource: "project",
            task: "check",
            exitCode: 0,
            finalOutput: "raw final output",
            outcome: " \t\r\n ",
            stderr: "",
          },
        ],
      },
    };
    const summary = getFeedbackSummaryText(
      toolResult as unknown as Parameters<typeof getFeedbackSummaryText>[0],
    );
    expect(summary).toBe("raw final output");
  });

  test("getFeedbackSummaryText returns (no output) when outcome and finalOutput are blank", () => {
    const toolResult = {
      content: [{ type: "text", text: "stale streaming activity" }],
      details: {
        mode: "single",
        agentScope: "project",
        projectAgentsDir: null,
        results: [
          {
            agent: "tester",
            agentSource: "project",
            task: "check",
            exitCode: 0,
            finalOutput: "   \n  ",
            outcome: " \t\r\n ",
            stderr: "",
          },
        ],
      },
    };
    const summary = getFeedbackSummaryText(
      toolResult as unknown as Parameters<typeof getFeedbackSummaryText>[0],
    );
    expect(summary).toBe("(no output)");
  });
});

describe("Negative / Failure Scenarios", () => {
  test("outcome is undefined if complete is missing", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"My helper response text with no complete tool call."}]}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
    expect(result.finalOutput).toBe(
      "My helper response text with no complete tool call.",
    );
  });

  test("outcome is undefined on aborted child process run", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Aborted outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Aborted outcome"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const { cwd } = await setupTest({ piScript });
    const controller = new AbortController();
    controller.abort();
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
    expect(outcome.result.outcome).toBeUndefined();
    expect(outcome.result.termination?.cancelReason).toBe(
      "The operation was aborted.",
    );
  });

  test("outcome is undefined on timeout child process run", async () => {
    const piScript = `#!/bin/sh
sleep 10
`;
    const { cwd } = await setupTest({ piScript });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 10);
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
    expect(outcome.result.outcome).toBeUndefined();
  });

  test("outcome is undefined on failed child process run", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Failed script outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Failed script outcome"}}}'
exit 1
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
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBeUndefined();
  });

  test("failed child process with complete message preserves exitCode and error representation", async () => {
    const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Should not be extracted"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Should not be extracted"}}}'
echo "critical stderr message" >&2
exit 1
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
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBeUndefined();
    expect(result.stderr).toContain("critical stderr message");
  });

  test("validation or extension-load failure with legacy outcome text does not trigger parsing recovery", async () => {
    const piScript = `#!/bin/sh
echo "Extension loading failed: missing module complete-extension" >&2
echo "Outcome: some legacy parsed outcome"
exit 1
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
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBeUndefined();
    expect(result.stderr).toContain("Extension loading failed");
  });

  test("sanitizeResultDetails preserves outcome", () => {
    const mockResult = {
      agent: "test-agent",
      agentSource: "user" as const,
      task: "test-task",
      exitCode: 0,
      finalOutput: "Done",
      stderr: "some stderr",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        contextTokens: 100,
        turns: 1,
      },
      outcome: "Successfully finished task",
    };
    const sanitized = sanitizeResultDetails(mockResult, false, undefined);
    expect(sanitized.outcome).toBe("Successfully finished task");
  });

  test("sanitizeDetailsForDisplay preserves outcome in subagent details", () => {
    const mockDetails = {
      mode: "single" as const,
      agentScope: "project" as const,
      projectAgentsDir: "/tmp",
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "test-task",
          exitCode: 0,
          finalOutput: "Done",
          stderr: "some stderr",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.01,
            contextTokens: 100,
            turns: 1,
          },
          outcome: "Successfully finished task",
        },
      ],
    };
    const sanitized = sanitizeDetailsForDisplay(mockDetails, false);
    expect(sanitized.results[0]?.outcome).toBe("Successfully finished task");
  });
});
