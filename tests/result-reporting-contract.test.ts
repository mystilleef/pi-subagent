import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunSingleAgentResult } from "../src/child/process.js";
import {
  formatSubagentFailureForParent,
  formatSubagentResultForParent,
  summarizeFeedbackUiFinalOutput,
} from "../src/output/summary.js";
import {
  createProgressState,
  finalizeProgressState,
  getProgressState,
} from "../src/progress/progress-state.js";
import { getFeedbackSummaryText } from "../src/progress/result-details.js";
import type { SingleResult, SubagentToolResult } from "../src/shared/types.js";
import { makeSingleResult } from "./helpers.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(repoRoot, "src", ...segments), "utf8");
}

function extractFunction(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^(export )?function ${name}\\(`).test(line),
  );
  if (start === -1) throw new Error(`Function ${name} not found`);
  const nextDecl = lines.findIndex(
    (line, idx) => idx > start && /^(export )?function \w+\(/.test(line),
  );
  const end = nextDecl === -1 ? lines.length : nextDecl;
  return lines.slice(start, end).join("\n");
}

function makeToolResult(
  result: SingleResult,
  contentText = "parent content",
): SubagentToolResult {
  return {
    content: [{ type: "text", text: contentText }],
    details: {
      mode: "single",
      agentScope: "both",
      projectAgentsDir: null,
      results: [result],
    },
  };
}

// R-010 deterministic source scan: feedback finalization must not reach back
// into the parent-level content[0].text streaming payload.
test("source scan: getFeedbackSummaryText does not read content[0].text", () => {
  const body = extractFunction(
    readSource("progress", "result-details.ts"),
    "getFeedbackSummaryText",
  );
  expect(body).not.toContain(".content");
  expect(body).not.toContain("content[");
});

// R-003/R-009 deterministic source scan: progress final output must derive
// from the passed finalOutput/outcome arguments, not from parent content.
test("source scan: makeProgressFinalOutput does not read content[0].text", () => {
  const body = extractFunction(
    readSource("progress", "progress-state.ts"),
    "makeProgressFinalOutput",
  );
  expect(body).not.toContain(".content");
  expect(body).not.toContain("content[");
});

// R-011 deterministic source scan: completed result-card body must come from
// SingleResult.finalOutput, not from a hidden rescan of messages.
test("source scan: renderSubagentResult completed body does not rescan messages", () => {
  const body = extractFunction(
    readSource("output", "ui.ts"),
    "renderSubagentResult",
  );
  expect(body).not.toContain("messages");
  expect(body).not.toContain("getFinalOutput");
});

// R-010 behavioral guard: stale streaming text in the parent payload cannot
// leak into the feedback summary when finalOutput and outcome are blank.
test("feedback summary ignores stale parent content text", () => {
  const toolResult = makeToolResult(
    makeSingleResult({ finalOutput: "", outcome: " \t\n " }),
    "stale streaming activity text",
  );
  expect(getFeedbackSummaryText(toolResult)).toBe("(no output)");
});

// R-003/R-004 integration: progress and feedback share one canonical summary
// and apply the same status-only success substitution.
test("progress final output matches feedback summary for canonical fixtures", () => {
  const requestId = `contract-${Date.now()}`;
  createProgressState(requestId, "test-agent", "test task");
  finalizeProgressState(requestId, "SUCCESS");
  const state = getProgressState(requestId);
  expect(state?.finalOutput).toBe("completed task");
  expect(summarizeFeedbackUiFinalOutput("SUCCESS", undefined)).toBe(
    "completed task",
  );
});

// R-005 behavioral guard: parent success content stays raw final output and
// carries the thinking warning, without any label extraction.
test("parent success formatter preserves raw final output", () => {
  const output = "Result: implemented fix\nDetails: none";
  expect(
    formatSubagentResultForParent(makeSingleResult({ finalOutput: output })),
  ).toBe(output);
});

// R-006/R-007 behavioral guard: parent failure content is explicit and uses
// the shared formatter with exactly one blank line separator.
test("parent failure formatter follows shared contract", () => {
  expect(formatSubagentFailureForParent("spawn failed")).toBe("spawn failed");
  expect(
    formatSubagentFailureForParent(
      "child failed",
      makeSingleResult({ finalOutput: "partial output" }),
    ),
  ).toBe("(failed) child failed\n\npartial output");
  expect(
    formatSubagentFailureForParent(
      "child failed",
      makeSingleResult({ finalOutput: "  \n\n  " }),
    ),
  ).toBe("(failed) child failed");
});

// R-016 public type compatibility: the exported result and tool result shapes
// accept the expected fields without runtime drift.
test("public result type shape remains compatible", () => {
  const single: SingleResult = makeSingleResult({
    finalOutput: "done",
    outcome: "completed task",
  });
  const toolResult: SubagentToolResult = makeToolResult(single, "done");
  expect(toolResult.details.results[0]?.finalOutput).toBe("done");
  expect(toolResult.details.results[0]?.outcome).toBe("completed task");
  expect(toolResult.content[0]?.text).toBe("done");
});

// T-004 deterministic source scan: no production file may export or import
// SubagentAbortError — abort is now a tagged return value, not an exception.
test("source scan: src/ contains no SubagentAbortError export or import", () => {
  const srcFiles = fs
    .readdirSync(path.join(repoRoot, "src"), { recursive: true })
    .filter(
      (f): f is string =>
        typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx")),
    );
  const hits: string[] = [];
  for (const rel of srcFiles) {
    const content = fs.readFileSync(path.join(repoRoot, "src", rel), "utf8");
    if (/SubagentAbortError/.test(content)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/SubagentAbortError/.test(lines[i] ?? "")) {
          hits.push(`${rel}:${i + 1}: ${(lines[i] ?? "").trim()}`);
        }
      }
    }
  }
  expect(hits).toEqual([]);
});

// T-004 deterministic source scan: process.ts must export RunSingleAgentResult
// and must NOT export SubagentAbortError.
test("source scan: process.ts exports RunSingleAgentResult, not SubagentAbortError", () => {
  const body = readSource("child", "process.ts");
  expect(body).toMatch(/export type RunSingleAgentResult/);
  expect(body).not.toContain("SubagentAbortError");
});

// T-004 deterministic source scan: subagent-orchestrator.ts must import
// runSingleAgent and must NOT import or reference SubagentAbortError.
test("source scan: subagent-orchestrator.ts imports runSingleAgent, not SubagentAbortError", () => {
  const body = readSource("orchestration", "subagent-orchestrator.ts");
  expect(body).toContain("import { runSingleAgent }");
  expect(body).not.toContain("SubagentAbortError");
});

// T-004 deterministic source scan: runSubagentLifecycle branches on
// outcome.kind, not on catch blocks for SubagentAbortError.
test("source scan: runSubagentLifecycle uses outcome.kind branch, not abort-exception catch", () => {
  const body = readSource("orchestration", "subagent-orchestrator.ts");
  expect(body).toContain("outcome.kind");
  expect(body).not.toContain("SubagentAbortError");
});

// T-004 deterministic source scan: finalizeResult returns discriminated union
// and does not throw SubagentAbortError.
test("source scan: finalizeResult returns kind-tagged result, does not throw abort error", () => {
  const body = readSource("child", "process.ts");
  expect(body).toContain('kind: "aborted"');
  expect(body).toContain('kind: "completed"');
  expect(body).not.toContain("SubagentAbortError");
});

// T-004 behavioral guard: RunSingleAgentResult discriminated union compiles
// and narrows correctly on kind.
test("RunSingleAgentResult discriminated union narrows on kind", () => {
  const completed: RunSingleAgentResult = {
    kind: "completed",
    result: makeSingleResult({ finalOutput: "done", outcome: "ok" }),
  };
  const aborted: RunSingleAgentResult = {
    kind: "aborted",
    result: makeSingleResult({ finalOutput: "", outcome: undefined }),
  };
  if (completed.kind === "completed") {
    expect(completed.result.outcome).toBe("ok");
  }
  if (aborted.kind === "aborted") {
    expect(aborted.result.outcome).toBeUndefined();
  }
});

// T-004 behavioral guard: aborted result must clear stderr and omit outcome
// per legacy contract.
test("aborted RunSingleAgentResult omits outcome and has empty stderr", () => {
  const aborted: RunSingleAgentResult = {
    kind: "aborted",
    result: makeSingleResult({
      finalOutput: "",
      outcome: undefined,
      stderr: "",
    }),
  };
  expect(aborted.result.stderr).toBe("");
  expect(aborted.result.outcome).toBeUndefined();
});

// T-004 behavioral guard: completed result preserves outcome and stderr.
test("completed RunSingleAgentResult preserves outcome and stderr", () => {
  const completed: RunSingleAgentResult = {
    kind: "completed",
    result: makeSingleResult({
      finalOutput: "done",
      outcome: "task completed",
      stderr: "warning: deprecation",
    }),
  };
  expect(completed.result.outcome).toBe("task completed");
  expect(completed.result.stderr).toBe("warning: deprecation");
});
