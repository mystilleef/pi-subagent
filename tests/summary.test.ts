import { expect, test } from "bun:test";
import { extractSemanticToolTarget } from "../src/output/normalize.js";
import {
  FEEDBACK_UI_SUMMARY_MAX_CHARS,
  formatSubagentFailureForParent,
  formatSubagentResultForParent,
  summarizeFeedbackUiFinalOutput,
} from "../src/output/summary.js";
import {
  clearProgressState,
  createProgressState,
  finalizeProgressState,
  getProgressState,
} from "../src/progress/progress-state.js";
import {
  getFeedbackSummaryText,
  sanitizeResultDetails,
} from "../src/progress/result-details.js";
import type { SingleResult } from "../src/shared/types.js";
import { CANONICAL_SUMMARY_FIXTURES } from "./fixtures.js";
import { makeSingleResult } from "./helpers.js";

function result(overrides: Partial<SingleResult>): SingleResult {
  return makeSingleResult(overrides);
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
  ).toBe("outcome: **rendered custom card body from message content.**");
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

test("feedback UI summarizer does not prefer legacy outcome label, so summary label wins", () => {
  expect(
    summarizeFeedbackUiFinalOutput(
      "Summary: Updated fallback rendering.\nOutcome: Preserved outcome precedence for feedback cards.",
    ),
  ).toBe("updated fallback rendering");
});

test("feedback UI summarizer does not prefer legacy outcome label, so status label wins", () => {
  expect(
    summarizeFeedbackUiFinalOutput(
      "Status: Added summary candidates.\nOutcome: Selected outcome before status labels.",
    ),
  ).toBe("added summary candidates");
});

test("feedback UI summarizer prefers new labels over unlabeled candidates", () => {
  expect(
    summarizeFeedbackUiFinalOutput(
      "Plain fallback candidate works.\nMessage: Recognized message label first.",
    ),
  ).toBe("recognized message label first");
});

test("feedback UI summarizer lower-cases and trims punctuation clutter without outcome-specific stripping", () => {
  expect(
    summarizeFeedbackUiFinalOutput("Outcome: Shipped RESULT CARD FIX!!!"),
  ).toBe("outcome: shipped result card fix");
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

test("extractSemanticToolTarget hides unknown args unless forced", () => {
  const secretArgs = {
    token: "secret-token",
    password: "secret-password",
    nested: { value: "hidden" },
  };
  expect(extractSemanticToolTarget(secretArgs)).toBe("");
  expect(extractSemanticToolTarget(secretArgs, true)).toBe(
    JSON.stringify(secretArgs),
  );
});

test("parent formatter prepends thinking warning when present", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput: "task completed",
        thinkingWarning:
          'Thinking level "xhigh" is not supported; using "high" instead (provider: openai, model: gpt-4o)',
      }),
    ),
  ).toBe(
    '[thinking] Thinking level "xhigh" is not supported; using "high" instead (provider: openai, model: gpt-4o)\n\ntask completed',
  );
});

test("parent formatter returns output unchanged when no thinking warning", () => {
  expect(
    formatSubagentResultForParent(result({ finalOutput: "task completed" })),
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
          'Thinking level "xhigh" is not supported; using "high" instead (provider: openai, model: gpt-4o)',
      }),
    ),
  ).toBe(
    '[thinking] Thinking level "xhigh" is not supported; using "high" instead (provider: openai, model: gpt-4o)\n\n',
  );
});

test("parent formatter prepends warning even when finalOutput is only whitespace", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput: "  \n\n  ",
        thinkingWarning:
          'Thinking level "xhigh" is not supported; using "high" instead (provider: openai, model: gpt-4o)',
      }),
    ),
  ).toBe(
    '[thinking] Thinking level "xhigh" is not supported; using "high" instead (provider: openai, model: gpt-4o)\n\n  \n\n  ',
  );
});

test("extractSemanticToolTarget keeps known safe targets", () => {
  expect(extractSemanticToolTarget({ command: "bun test" })).toBe("bun test");
  expect(extractSemanticToolTarget({ path: "src/index.ts" })).toBe(
    "src/index.ts",
  );
  expect(
    extractSemanticToolTarget({
      agent: "reviewer",
      task: "**Check UI**",
      agentScope: "project",
    }),
  ).toBe("reviewer");
});

test("extractSemanticToolTarget uses semantic key priority order", () => {
  expect(extractSemanticToolTarget({ query: "typescript" })).toBe("typescript");
  expect(extractSemanticToolTarget({ url: "https://example.com" })).toBe(
    "https://example.com",
  );
  expect(extractSemanticToolTarget({ action: "click" })).toBe("click");
  expect(extractSemanticToolTarget({ name: "custom-tool" })).toBe(
    "custom-tool",
  );
});

test("extractSemanticToolTarget falls back to empty when no semantic key has a non-blank string", () => {
  expect(
    extractSemanticToolTarget({
      token: "secret",
      nested: { value: "hidden" },
    }),
  ).toBe("");
  expect(extractSemanticToolTarget({ command: "  \n\t  " })).toBe("");
});

test("extractSemanticToolTarget falls back to first safe non-blank string", () => {
  expect(extractSemanticToolTarget({ project: "my-project" })).toBe(
    "my-project",
  );
  expect(extractSemanticToolTarget({ project: "my-project", count: 42 })).toBe(
    "my-project",
  );
});

test("extractSemanticToolTarget skips secret-like keys in fallback", () => {
  expect(
    extractSemanticToolTarget({
      token: "x",
      project: "my-project",
    }),
  ).toBe("my-project");
  expect(
    extractSemanticToolTarget({
      password: "pw",
      auth: "bearer-token",
      data: "safe-data",
    }),
  ).toBe("safe-data");
});

test("extractSemanticToolTarget suppresses fallback when all keys are secret-like", () => {
  expect(
    extractSemanticToolTarget({
      token: "x",
      password: "y",
    }),
  ).toBe("");
});

test("extractSemanticToolTarget suppresses fallback for secret-like long values", () => {
  expect(
    extractSemanticToolTarget({
      project: "a".repeat(65),
    }),
  ).toBe("");
  expect(
    extractSemanticToolTarget({
      project:
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    }),
  ).toBe("");
});

test("extractSemanticToolTarget returns empty when args have only non-string values", () => {
  expect(
    extractSemanticToolTarget({
      nested: { value: "hidden" },
      count: 42,
      flag: true,
    }),
  ).toBe("");
});

test("extractSemanticToolTarget forced JSON bypasses fallback safety", () => {
  const safeArgs = { project: "my-project" };
  expect(extractSemanticToolTarget(safeArgs, true)).toBe(
    JSON.stringify(safeArgs),
  );
  const secretArgs = { token: "x", password: "y" };
  expect(extractSemanticToolTarget(secretArgs, true)).toBe(
    JSON.stringify(secretArgs),
  );
});

test("summarizeFeedbackUiFinalOutput prefers explicit outcome parameter first", () => {
  expect(
    summarizeFeedbackUiFinalOutput("some final output", "My Typed Outcome!"),
  ).toBe("my typed outcome");
});

test("summarizeFeedbackUiFinalOutput with empty outcome falls back to finalOutput without outcome-specific stripping", () => {
  expect(summarizeFeedbackUiFinalOutput("Outcome: Some Text", "")).toBe(
    "outcome: some text",
  );
  expect(summarizeFeedbackUiFinalOutput("Outcome: Some Text", undefined)).toBe(
    "outcome: some text",
  );
});

test("summarizeFeedbackUiFinalOutput with long outcome truncates to 120 chars", () => {
  const longOutcome = `Implemented ${"special result ".repeat(20)}for card display.`;
  const result = summarizeFeedbackUiFinalOutput(
    "some final output",
    longOutcome,
  );
  expect(Array.from(result).length).toBe(FEEDBACK_UI_SUMMARY_MAX_CHARS);
  expect(result.endsWith("…")).toBe(true);
});

test("sanitized details preserves outcome and fails if dropped", () => {
  const mockResult = result({
    outcome: "Preserved outcome here",
  });
  const sanitized = sanitizeResultDetails(mockResult, false, undefined);
  expect(sanitized.outcome).toBe("Preserved outcome here");
});

test("feedback summary text preserves outcome and fails if dropped", () => {
  const mockSubagentResult = {
    content: [{ type: "text" as const, text: "ignored parent content" }],
    details: {
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      results: [
        result({
          finalOutput: "final output text",
          outcome: "Preserved outcome details",
        }),
      ],
    },
  };
  const summary = getFeedbackSummaryText(
    mockSubagentResult as unknown as Parameters<
      typeof getFeedbackSummaryText
    >[0],
  );
  expect(summary).toBe("preserved outcome details");
});

test("progress state preserves outcome and fails if dropped", () => {
  const requestId = `test-id-${Date.now()}`;
  createProgressState(requestId, "test-agent", "user", "test task");
  finalizeProgressState(
    requestId,
    "final output description",
    "Preserved task outcome",
  );
  const state = getProgressState(requestId);
  expect(state?.finalOutput).toBe("preserved task outcome");
  clearProgressState(requestId);
});

test("UI summary preserves outcome and fails if dropped", () => {
  const outcomeText = "My explicit outcome";
  const summary = summarizeFeedbackUiFinalOutput("ignored output", outcomeText);
  expect(summary).toBe("my explicit outcome");
});

for (const fixture of CANONICAL_SUMMARY_FIXTURES) {
  test(`feedback summary matches canonical summary for ${fixture.name}`, () => {
    const toolResult = {
      content: [{ type: "text" as const, text: "stale streaming text" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          result({
            finalOutput: fixture.finalOutput,
            outcome: fixture.outcome,
          }),
        ],
      },
    };
    const summary = getFeedbackSummaryText(
      toolResult as unknown as Parameters<typeof getFeedbackSummaryText>[0],
    );
    expect(summary).toBe(fixture.expectedSummary);
  });
}

test("feedback summary returns (no output) when result has no content", () => {
  const toolResult = {
    content: [{ type: "text" as const, text: "stale streaming text" }],
    details: {
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      results: [
        result({
          finalOutput: "   \n  ",
          outcome: " \t\r\n ",
        }),
      ],
    },
  };
  const summary = getFeedbackSummaryText(
    toolResult as unknown as Parameters<typeof getFeedbackSummaryText>[0],
  );
  expect(summary).toBe("(no output)");
});

test("failure formatter returns error message unchanged without latest result", () => {
  expect(formatSubagentFailureForParent("spawn failed")).toBe("spawn failed");
});

test("failure formatter returns only prefix for whitespace-only formatted output", () => {
  expect(
    formatSubagentFailureForParent(
      "child failed",
      result({ finalOutput: "  \n\n  " }),
    ),
  ).toBe("(failed) child failed");
});

test("failure formatter appends formatted final output after one blank line", () => {
  expect(
    formatSubagentFailureForParent(
      "child failed",
      result({ finalOutput: "partial output\nmore output" }),
    ),
  ).toBe("(failed) child failed\n\npartial output\nmore output");
});

test("failure formatter includes thinking warning in appended formatted output", () => {
  expect(
    formatSubagentFailureForParent(
      "child failed",
      result({
        finalOutput: "partial output",
        thinkingWarning: 'Thinking level "xhigh" not supported',
      }),
    ),
  ).toBe(
    '(failed) child failed\n\n[thinking] Thinking level "xhigh" not supported\n\npartial output',
  );
});
