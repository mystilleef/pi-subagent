import { expect, test } from "bun:test";
import {
  extractSemanticToolTarget,
  formatSubagentResultForParent,
  isFailureDiagnosticLine,
  isTranscriptNoiseLine,
} from "../src/summary.js";
import type { SingleResult } from "../src/types.js";

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

test("parent formatter filters transcript noise lines", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput:
          "Hello! I can help.\nApologies for the delay.\nActual result here.",
      }),
    ),
  ).toBe("Actual result here.");
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput:
          "Hi there\nHi, there\nHigh severity issue\nhistory\nhiatus",
      }),
    ),
  ).toBe("High severity issue\nhistory\nhiatus");
});

test("parent formatter filters failure diagnostic lines", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput:
          "at Object.<anonymous> (/tmp/test.ts:1:1)\nError: bad import\nMigration applied successfully.",
      }),
    ),
  ).toBe("Migration applied successfully.");
});

test("parent formatter returns empty string for empty output", () => {
  expect(formatSubagentResultForParent(result({ finalOutput: "" }))).toBe("");
  expect(
    formatSubagentResultForParent(result({ finalOutput: "  \n  \n  " })),
  ).toBe("");
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
