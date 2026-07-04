import { describe, expect, test } from "bun:test";
import { formatSubagentToolResult } from "../src/orchestration/subagent-orchestrator.js";
import type {
  SubagentDetails,
  SubagentToolResult,
} from "../src/shared/types.js";

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
