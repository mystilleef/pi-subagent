import { expect, test } from "bun:test";
import {
  compactChangedPathList,
  extractSummaryLabels,
  formatSubagentResultForParent,
  isNoOpSummaryValue,
  normalizeSummaryValue,
} from "../src/summary.js";
import type { SingleResult } from "../src/types.js";

test("shared summary helpers parse and normalize labeled output", () => {
  const summary = extractSummaryLabels(
    "- outcome: **shipped across\nmultiple lines**\n**Changed:** `src/ui.ts`\n### Verification\n`bun test`\nNext: none",
  );
  expect(summary).toEqual({
    Outcome: "**shipped across multiple lines**",
    Changed: "`src/ui.ts`",
    Verification: "`bun test`",
    Next: "none",
  });
  expect(normalizeSummaryValue(summary.Outcome ?? "")).toBe(
    "shipped across multiple lines",
  );
  expect(normalizeSummaryValue(summary.Changed ?? "", "Changed")).toBe(
    "src/ui.ts",
  );
  expect(normalizeSummaryValue(summary.Verification ?? "")).toBe("bun test");
  expect(isNoOpSummaryValue(summary.Next ?? "")).toBe(true);
});

test("shared summary helpers parse legacy evidence as verification", () => {
  const summary = extractSummaryLabels(
    "Outcome: ok\nEvidence: bun test passed",
  );
  expect(summary).toEqual({
    Outcome: "ok",
    Verification: "bun test passed",
  });
});

test("changed path compaction only compacts clear long path lists", () => {
  expect(
    compactChangedPathList("src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts"),
  ).toBe("5 files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, …");
  expect(compactChangedPathList("src/a.ts, maybe docs, src/c.ts")).toBe(
    "src/a.ts, maybe docs, src/c.ts",
  );
});

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

test("parent formatter emits useful success fields only", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput:
          "Outcome: shipped\nChanged: src/a.ts\nVerification: bun test\nNext: none",
      }),
    ),
  ).toBe("Outcome: shipped\nChanged: src/a.ts\nVerification: bun test");
});

test("parent formatter emits useful failure fields with cause fallback", () => {
  expect(
    formatSubagentResultForParent(
      result({
        exitCode: 1,
        finalOutput:
          "Outcome: failed at verify\nVerification: type error\nNext: fix types",
        errorMessage: "Subagent tool result failed.",
      }),
    ),
  ).toBe(
    "Outcome: failed at verify\nCause: Subagent tool result failed.\nVerification: type error\nNext: fix types",
  );
});

test("parent formatter compacts changed paths and omits no-op values", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput:
          "Outcome: ok\nChanged: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts\nVerification: not applicable\nNext: unchanged",
      }),
    ),
  ).toBe(
    "Outcome: ok\nChanged: 5 files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, …",
  );
});

test("parent formatter omits duplicate semantic values", () => {
  expect(
    formatSubagentResultForParent(
      result({
        finalOutput:
          "Outcome: shipped\nChanged: src/a.ts\nVerification: shipped\nNext: src/a.ts",
      }),
    ),
  ).toBe("Outcome: shipped\nChanged: src/a.ts");
});

test("parent formatter returns first meaningful fallback when no useful summary fields parse", () => {
  expect(
    formatSubagentResultForParent(result({ finalOutput: "\nplain result\n" })),
  ).toBe("plain result");
});

test("parent formatter preserves long semantic values without field budgets", () => {
  const formatted = formatSubagentResultForParent(
    result({
      finalOutput: `Outcome: ${"o".repeat(200)}\nChanged: src/a.ts\nVerification: ${"e".repeat(220)}\nNext: ${"n".repeat(180)}`,
    }),
  );
  expect(formatted).toContain(`Outcome: ${"o".repeat(200)}`);
  expect(formatted).toContain(`Verification: ${"e".repeat(220)}`);
  expect(formatted).toContain(`Next: ${"n".repeat(180)}`);
});

test("parent formatter extracts actionable stderr failure cause without raw log leak", () => {
  const formatted = formatSubagentResultForParent(
    result({
      exitCode: 1,
      finalOutput: "Outcome: failed\nVerification: bun verify",
      stderr: `debug line ${"x".repeat(300)}\nError: bad import\ncommand output ${"y".repeat(300)}`,
    }),
  );
  expect(formatted).toBe(
    "Outcome: failed\nCause: bad import\nVerification: bun verify",
  );
  expect(formatted).not.toContain("debug line");
  expect(formatted).not.toContain("command output");
});

test("parent formatter fallback keeps the first meaningful line", () => {
  const formatted = formatSubagentResultForParent(
    result({ finalOutput: `\n${"x".repeat(300)}\nsecond line\nthird line` }),
  );
  expect(formatted).toBe("x".repeat(300));
});

test("parent formatter strips transcript noise and no-op fields from semantic output", () => {
  const formatted = formatSubagentResultForParent(
    result({
      finalOutput:
        "Hello! I can help.\nReasoning: checked the repo\nOutcome: shipped\nChanged: none\nVerification: bun test\nNext: none\nRaw log: stack trace\nApologies for the issue",
    }),
  );
  expect(formatted).toBe("Outcome: shipped\nVerification: bun test");
  expect(formatted).not.toContain("Hello");
  expect(formatted).not.toContain("Reasoning");
  expect(formatted).not.toContain("Apologies");
});

test("parent formatter chooses first actionable failure cause by precedence", () => {
  expect(
    formatSubagentResultForParent(
      result({
        exitCode: 1,
        finalOutput:
          "Outcome: failed\nCause: assertion mismatch\nVerification: bun test\nError: raw output failure",
        stderr: "stderr failure",
        errorMessage: "error message failure",
      }),
    ),
  ).toContain("Cause: assertion mismatch");
  expect(
    formatSubagentResultForParent(
      result({
        exitCode: 1,
        finalOutput:
          "Outcome: failed\nVerification: bun test\n    at Object.<anonymous> (/tmp/test.ts:1:1)\nError: raw output failure",
        stderr: "stderr failure",
        errorMessage: "error message failure",
      }),
    ),
  ).toContain("Cause: error message failure");
  expect(
    formatSubagentResultForParent(
      result({
        exitCode: 1,
        finalOutput:
          "Outcome: failed\nVerification: bun test\n    at Object.<anonymous> (/tmp/test.ts:1:1)\nError: raw output failure",
        stderr: "Failed: stderr failure",
      }),
    ),
  ).toContain("Cause: stderr failure");
  expect(
    formatSubagentResultForParent(
      result({
        exitCode: 1,
        stderr: "noise\n    at stderrFrame (/tmp/stderr.ts:1:1)",
        finalOutput:
          "Outcome: failed\nVerification: bun test\nError: raw output failure",
      }),
    ),
  ).toContain("Cause: stderrFrame (/tmp/stderr.ts:1:1)");
  expect(
    formatSubagentResultForParent(
      result({
        exitCode: 1,
        finalOutput:
          "Outcome: failed\nVerification: bun test\n    at Object.<anonymous> (/tmp/test.ts:1:1)\nError: raw output failure",
      }),
    ),
  ).toContain("Cause: raw output failure");
  expect(
    formatSubagentResultForParent(
      result({
        exitCode: 1,
        finalOutput:
          "Outcome: failed\nVerification: bun test\n    at Object.<anonymous> (/tmp/test.ts:1:1)",
      }),
    ),
  ).toContain("Cause: Object.<anonymous> (/tmp/test.ts:1:1)");
});

test("parent formatter fallback follows semantic priority", () => {
  expect(
    formatSubagentResultForParent(
      result({ finalOutput: "intro paragraph\nResult: packaged build" }),
    ),
  ).toBe("Result: packaged build");
  expect(
    formatSubagentResultForParent(
      result({ finalOutput: "intro paragraph\nSuccess: packaged build" }),
    ),
  ).toBe("Success: packaged build");
  expect(
    formatSubagentResultForParent(
      result({ finalOutput: "intro paragraph\nbun test passed" }),
    ),
  ).toBe("bun test passed");
  expect(
    formatSubagentResultForParent(
      result({ finalOutput: "first paragraph\n\nsecond paragraph" }),
    ),
  ).toBe("first paragraph");
});
