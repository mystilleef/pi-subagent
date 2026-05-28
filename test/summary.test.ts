import { expect, test } from "bun:test";
import {
  extractSemanticToolTarget,
  filterOutputLines,
  isFailureDiagnosticLine,
  isTranscriptNoiseLine,
} from "../src/output/normalize.js";
import {
  FEEDBACK_UI_SUMMARY_MAX_CHARS,
  formatSubagentResultForParent,
  summarizeFeedbackUiFinalOutput,
} from "../src/output/summary.js";
import type { SingleResult } from "../src/shared/types.js";

function result(overrides: Partial<SingleResult>): SingleResult {
  return {
    agent: "tester",
    agentSource: "project",
    task: "check",
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
    ...overrides,
  };
}

test("parent formatter returns all non-noise lines", () => {
  expect(
    formatSubagentResultForParent(
      result({ finalOutput: "line one\nline two\nline three\nline four" }),
    ),
  ).toBe("line one\nline two\nline three\nline four");
});

test("parent formatter preserves transcript-like and diagnostic lines", () => {
  const output =
    "Hello! I can help.\nError: bad import\nFailed: command exited\nTraceback (most recent call last):\nat Object.<anonymous> (/tmp/test.ts:1:1)\nActual result here.";
  expect(formatSubagentResultForParent(result({ finalOutput: output }))).toBe(
    output,
  );
});

test("parent formatter preserves blank lines and surrounding whitespace", () => {
  const output = "  \n\n  padded result  \n\n";
  expect(formatSubagentResultForParent(result({ finalOutput: output }))).toBe(
    output,
  );
});

test("parent formatter returns empty string for empty output", () => {
  expect(formatSubagentResultForParent(result({ finalOutput: "" }))).toBe("");
});

test("parent formatter returns plain prose without label extraction", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput:
          "Migration applied to 3 tables. All tests pass. No rollback needed.",
      }),
    ),
  ).toBe("Migration applied to 3 tables. All tests pass. No rollback needed.");
});

test("feedback UI summarizer strips labels and cleans markdown", () => {
  expect(
    summarizeFeedbackUiFinalOutput(
      "## Summary:\n- Outcome: **Rendered custom card body from message content.**",
    ),
  ).toBe("rendered custom card body from message content");
  expect(
    summarizeFeedbackUiFinalOutput("```\nResult: `Updated src/ui.ts`.\n```"),
  ).toBe("updated src/ui.ts");
});

test("feedback UI summarizer prefers concrete action candidates", () => {
  expect(
    summarizeFeedbackUiFinalOutput(
      "Verification: bun test passed.\nProject summary: Routed run result cards through summarized message content.",
    ),
  ).toBe("routed run result cards through summarized message content");
});

test("feedback UI summarizer prefers later outcome over earlier summary", () => {
  expect(
    summarizeFeedbackUiFinalOutput(
      "Summary: Updated fallback rendering.\nOutcome: Preserved outcome precedence for feedback cards.",
    ),
  ).toBe("preserved outcome precedence for feedback cards");
});

test("feedback UI summarizer prefers later outcome over earlier status", () => {
  expect(
    summarizeFeedbackUiFinalOutput(
      "Status: Added summary candidates.\nOutcome: Selected outcome before status labels.",
    ),
  ).toBe("selected outcome before status labels");
});

test("feedback UI summarizer prefers new labels over unlabeled candidates", () => {
  expect(
    summarizeFeedbackUiFinalOutput(
      "Plain fallback candidate works.\nMessage: Recognized message label first.",
    ),
  ).toBe("recognized message label first");
});

test("feedback UI summarizer lower-cases and trims punctuation clutter", () => {
  expect(
    summarizeFeedbackUiFinalOutput("Outcome: Shipped RESULT CARD FIX!!!"),
  ).toBe("shipped result card fix");
});

test("feedback UI summarizer truncates compact output", () => {
  const summary = summarizeFeedbackUiFinalOutput(
    `Outcome: Implemented ${"semantic result ".repeat(20)}for run cards.`,
  );
  expect(Array.from(summary).length).toBe(FEEDBACK_UI_SUMMARY_MAX_CHARS);
  expect(summary.endsWith("…")).toBe(true);
});

test("feedback UI summarizer falls back for generic status-only output", () => {
  expect(summarizeFeedbackUiFinalOutput("Summary\nStatus: success\nDone")).toBe(
    "completed task",
  );
});

test("parent formatter remains raw formatted content", () => {
  expect(
    formatSubagentResultForParent(
      result({ finalOutput: "Outcome: Shipped fix.\nVerification: bun test" }),
    ),
  ).toBe("Outcome: Shipped fix.\nVerification: bun test");
});

test("isTranscriptNoiseLine identifies noise correctly", () => {
  expect(isTranscriptNoiseLine("Hello! I can help.")).toBe(true);
  expect(isTranscriptNoiseLine("Hi there")).toBe(true);
  expect(isTranscriptNoiseLine("Hi, there")).toBe(true);
  expect(isTranscriptNoiseLine("Reasoning: I checked the repo")).toBe(true);
  expect(isTranscriptNoiseLine("Raw log: child output")).toBe(true);
  expect(isTranscriptNoiseLine("Apologies for the issue")).toBe(true);
  expect(isTranscriptNoiseLine("Sorry for the issue")).toBe(true);
  expect(isTranscriptNoiseLine("High severity issue")).toBe(false);
  expect(isTranscriptNoiseLine("history matters")).toBe(false);
  expect(isTranscriptNoiseLine("hiatus planned")).toBe(false);
  expect(isTranscriptNoiseLine("Migration applied successfully.")).toBe(false);
});

test("isFailureDiagnosticLine identifies diagnostics correctly", () => {
  expect(isFailureDiagnosticLine("Error: bad import")).toBe(true);
  expect(isFailureDiagnosticLine("at Object.<anonymous> (/tmp/x.ts:1:1)")).toBe(
    true,
  );
  expect(isFailureDiagnosticLine("Migration applied.")).toBe(false);
});

test("filterOutputLines keeps UI-only filtering behavior", () => {
  expect(
    filterOutputLines(
      "Hello! I can help.\nApologies for the delay.\nActual result here.",
    ),
  ).toEqual(["Actual result here."]);
  expect(
    filterOutputLines(
      "at Object.<anonymous> (/tmp/test.ts:1:1)\nError: bad import\nMigration applied successfully.",
    ),
  ).toEqual(["Migration applied successfully."]);
  expect(
    filterOutputLines("Hi there\nHigh severity issue\nhistory\nhiatus"),
  ).toEqual(["High severity issue", "history", "hiatus"]);
});

test("extractSemanticToolTarget hides unknown args unless forced", () => {
  const secretArgs = {
    token: "secret-token",
    password: "secret-password",
    nested: { value: "hidden" },
  };
  expect(extractSemanticToolTarget("unknown", secretArgs)).toBe("");
  expect(extractSemanticToolTarget("unknown", secretArgs, true)).toBe(
    JSON.stringify(secretArgs),
  );
});

test("parent formatter prepends thinking warning when present", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput: "task completed",
        thinkingWarning:
          'Thinking level "xhigh" not supported by model "openai/gpt-4o"; using "high" instead',
      }),
    ),
  ).toBe(
    '[thinking] Thinking level "xhigh" not supported by model "openai/gpt-4o"; using "high" instead\n\ntask completed',
  );
});

test("parent formatter returns output unchanged when no thinking warning", () => {
  expect(
    formatSubagentResultForParent(
      result({ finalOutput: "task completed", thinkingWarning: undefined }),
    ),
  ).toBe("task completed");
});

test("parent formatter returns output unchanged when thinking warning is empty", () => {
  expect(
    formatSubagentResultForParent(
      result({ finalOutput: "task completed", thinkingWarning: "" }),
    ),
  ).toBe("task completed");
});

test("parent formatter prepends warning even when finalOutput is empty", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput: "",
        thinkingWarning:
          'Thinking level "xhigh" not supported by model "openai/gpt-4o"; using "high" instead',
      }),
    ),
  ).toBe(
    '[thinking] Thinking level "xhigh" not supported by model "openai/gpt-4o"; using "high" instead\n\n',
  );
});

test("parent formatter prepends warning even when finalOutput is only whitespace", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput: "  \n\n  ",
        thinkingWarning:
          'Thinking level "xhigh" not supported by model "openai/gpt-4o"; using "high" instead',
      }),
    ),
  ).toBe(
    '[thinking] Thinking level "xhigh" not supported by model "openai/gpt-4o"; using "high" instead\n\n  \n\n  ',
  );
});

test("extractSemanticToolTarget keeps known safe targets", () => {
  expect(extractSemanticToolTarget("bash", { command: "bun test" })).toBe(
    "bun test",
  );
  expect(extractSemanticToolTarget("read", { path: "src/index.ts" })).toBe(
    "src/index.ts",
  );
  expect(
    extractSemanticToolTarget("subagent", {
      agent: "reviewer",
      task: "**Check UI**",
      agentScope: "project",
    }),
  ).toBe("reviewer Check UI [project]");
});
