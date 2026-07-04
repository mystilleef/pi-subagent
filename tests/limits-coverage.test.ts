import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_END_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_OUTPUT_LINES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  getSubagentOutputLimits,
  getSubagentRuntimeLimits,
  truncateOutput,
} from "../src/shared/limits.js";

const ALL_LIMIT_ENV_VARS = [
  "PI_SUBAGENT_MAX_OUTPUT_BYTES",
  "PI_SUBAGENT_MAX_OUTPUT_LINES",
  "PI_SUBAGENT_AGENT_END_GRACE_MS",
  "PI_SUBAGENT_MAX_STDERR_BYTES",
  "PI_SUBAGENT_MAX_DEPTH",
];

function clearLimitEnv() {
  for (const key of ALL_LIMIT_ENV_VARS) {
    delete process.env[key];
  }
}

afterEach(clearLimitEnv);

describe("getSubagentOutputLimits", () => {
  test("returns defaults when no env vars are set", () => {
    clearLimitEnv();
    const limits = getSubagentOutputLimits();
    expect(limits.maxBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(limits.maxLines).toBe(DEFAULT_MAX_OUTPUT_LINES);
  });

  test("parses valid string env values for maxBytes", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES = "12345";
    const limits = getSubagentOutputLimits();
    expect(limits.maxBytes).toBe(12345);
    expect(limits.maxLines).toBe(DEFAULT_MAX_OUTPUT_LINES);
  });

  test("parses valid string env values for maxLines", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_LINES = "42";
    const limits = getSubagentOutputLimits();
    expect(limits.maxBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(limits.maxLines).toBe(42);
  });

  test("parses both env vars set to valid strings", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES = "9999";
    process.env.PI_SUBAGENT_MAX_OUTPUT_LINES = "77";
    const limits = getSubagentOutputLimits();
    expect(limits.maxBytes).toBe(9999);
    expect(limits.maxLines).toBe(77);
  });

  test("falls back to defaults when env vars are non-numeric strings", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES = "abc";
    process.env.PI_SUBAGENT_MAX_OUTPUT_LINES = "xyz";
    const limits = getSubagentOutputLimits();
    expect(limits.maxBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(limits.maxLines).toBe(DEFAULT_MAX_OUTPUT_LINES);
  });

  test("falls back to defaults when env vars are zero", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES = "0";
    process.env.PI_SUBAGENT_MAX_OUTPUT_LINES = "0";
    const limits = getSubagentOutputLimits();
    expect(limits.maxBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(limits.maxLines).toBe(DEFAULT_MAX_OUTPUT_LINES);
  });

  test("falls back to defaults when env vars are negative", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES = "-5";
    process.env.PI_SUBAGENT_MAX_OUTPUT_LINES = "-1";
    const limits = getSubagentOutputLimits();
    expect(limits.maxBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(limits.maxLines).toBe(DEFAULT_MAX_OUTPUT_LINES);
  });

  test("falls back to defaults when env vars are non-integer floats", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES = "3.14";
    process.env.PI_SUBAGENT_MAX_OUTPUT_LINES = "1.5";
    const limits = getSubagentOutputLimits();
    expect(limits.maxBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(limits.maxLines).toBe(DEFAULT_MAX_OUTPUT_LINES);
  });

  test("falls back to defaults when env vars are NaN strings", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES = "NaN";
    const limits = getSubagentOutputLimits();
    expect(limits.maxBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
  });

  test("accepts a custom config object", () => {
    const limits = getSubagentOutputLimits({
      PI_SUBAGENT_MAX_OUTPUT_BYTES: "555",
      PI_SUBAGENT_MAX_OUTPUT_LINES: "10",
    });
    expect(limits.maxBytes).toBe(555);
    expect(limits.maxLines).toBe(10);
  });

  test("custom config with number values", () => {
    const limits = getSubagentOutputLimits({
      PI_SUBAGENT_MAX_OUTPUT_BYTES: 2000,
      PI_SUBAGENT_MAX_OUTPUT_LINES: 100,
    });
    expect(limits.maxBytes).toBe(2000);
    expect(limits.maxLines).toBe(100);
  });
});

describe("getSubagentRuntimeLimits", () => {
  test("returns defaults when no env vars are set", () => {
    clearLimitEnv();
    const limits = getSubagentRuntimeLimits();
    expect(limits.agentEndGraceMs).toBe(DEFAULT_AGENT_END_GRACE_MS);
    expect(limits.maxStderrBytes).toBe(DEFAULT_MAX_STDERR_BYTES);
    expect(limits.maxDepth).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
  });

  test("parses valid string env values for all fields", () => {
    process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "500";
    process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "2048";
    process.env.PI_SUBAGENT_MAX_DEPTH = "5";
    const limits = getSubagentRuntimeLimits();
    expect(limits.agentEndGraceMs).toBe(500);
    expect(limits.maxStderrBytes).toBe(2048);
    expect(limits.maxDepth).toBe(5);
  });

  test("caps maxDepth at the ceiling of 10", () => {
    process.env.PI_SUBAGENT_MAX_DEPTH = "99";
    const limits = getSubagentRuntimeLimits();
    expect(limits.maxDepth).toBe(10);
  });

  test("caps maxDepth at ceiling when set to exactly 10", () => {
    process.env.PI_SUBAGENT_MAX_DEPTH = "10";
    const limits = getSubagentRuntimeLimits();
    expect(limits.maxDepth).toBe(10);
  });

  test("caps maxDepth at ceiling when set to 11", () => {
    process.env.PI_SUBAGENT_MAX_DEPTH = "11";
    const limits = getSubagentRuntimeLimits();
    expect(limits.maxDepth).toBe(10);
  });

  test("falls back to defaults for invalid string values", () => {
    process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "not-a-number";
    process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "xyz";
    process.env.PI_SUBAGENT_MAX_DEPTH = "abc";
    const limits = getSubagentRuntimeLimits();
    expect(limits.agentEndGraceMs).toBe(DEFAULT_AGENT_END_GRACE_MS);
    expect(limits.maxStderrBytes).toBe(DEFAULT_MAX_STDERR_BYTES);
    expect(limits.maxDepth).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
  });

  test("falls back to default for zero depth", () => {
    process.env.PI_SUBAGENT_MAX_DEPTH = "0";
    const limits = getSubagentRuntimeLimits();
    expect(limits.maxDepth).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
  });

  test("falls back to defaults for negative values", () => {
    process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "-1";
    process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "-5";
    const limits = getSubagentRuntimeLimits();
    expect(limits.agentEndGraceMs).toBe(DEFAULT_AGENT_END_GRACE_MS);
    expect(limits.maxStderrBytes).toBe(DEFAULT_MAX_STDERR_BYTES);
  });

  test("accepts a custom config object", () => {
    const limits = getSubagentRuntimeLimits({
      PI_SUBAGENT_AGENT_END_GRACE_MS: "300",
      PI_SUBAGENT_MAX_STDERR_BYTES: "1024",
      PI_SUBAGENT_MAX_DEPTH: "3",
    });
    expect(limits.agentEndGraceMs).toBe(300);
    expect(limits.maxStderrBytes).toBe(1024);
    expect(limits.maxDepth).toBe(3);
  });

  test("custom config with number values", () => {
    const limits = getSubagentRuntimeLimits({
      PI_SUBAGENT_AGENT_END_GRACE_MS: 600,
      PI_SUBAGENT_MAX_STDERR_BYTES: 4096,
      PI_SUBAGENT_MAX_DEPTH: 7,
    });
    expect(limits.agentEndGraceMs).toBe(600);
    expect(limits.maxStderrBytes).toBe(4096);
    expect(limits.maxDepth).toBe(7);
  });

  test("custom config depth > 10 gets capped", () => {
    const limits = getSubagentRuntimeLimits({
      PI_SUBAGENT_MAX_DEPTH: 99,
    });
    expect(limits.maxDepth).toBe(10);
  });
});

describe("truncateOutput", () => {
  test("returns text unchanged when within limits", () => {
    const text = "short text\nwith two lines";
    const result = truncateOutput(text, { maxBytes: 1000, maxLines: 10 });
    expect(result).toBe(text);
  });

  test("truncates lines when over line limit", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const result = truncateOutput(text, { maxBytes: 10000, maxLines: 3 });
    expect(result).toContain("[TRUNCATED: first 3 of 5 lines]");
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("line3");
    expect(result).not.toContain("line4");
  });

  test("truncates bytes when over byte limit but within line limit", () => {
    const text = `${"a".repeat(100)}\n${"b".repeat(100)}`;
    const result = truncateOutput(text, { maxBytes: 50, maxLines: 10 });
    // 2 lines fit within 10-line limit, but 202 bytes exceeds 50 → byte truncation
    // After byte truncation, only first line (or part of it) survives → kept=1
    expect(result).toContain("[TRUNCATED: first 1 of 2 lines]");
    const payloadStart = result.indexOf("\n");
    const payload = result.slice(payloadStart + 1);
    expect(Buffer.byteLength(payload, "utf-8")).toBeLessThanOrEqual(50);
  });

  test("applies line truncation then byte truncation when both limits exceeded", () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `line ${String(i).padStart(3, "0")}`,
    );
    const text = lines.join("\n");
    const result = truncateOutput(text, { maxBytes: 30, maxLines: 5 });
    // Line-truncated to 5 lines (~44 bytes), then byte-truncated to 30
    // Byte truncation splits mid-line, so kept count may be less than 5
    expect(result).toContain("[TRUNCATED: first ");
    expect(result).toContain(" of 20 lines]");
    const payloadStart = result.indexOf("\n");
    const payload = result.slice(payloadStart + 1);
    expect(Buffer.byteLength(payload, "utf-8")).toBeLessThanOrEqual(30);
  });

  test("handles single-line text within byte limit", () => {
    const text = "hello";
    const result = truncateOutput(text, { maxBytes: 100, maxLines: 1 });
    expect(result).toBe("hello");
  });

  test("handles single-line text exceeding byte limit", () => {
    const text = "a".repeat(100);
    const result = truncateOutput(text, { maxBytes: 10, maxLines: 10 });
    expect(result).toContain("[TRUNCATED: first 1 of 1 lines]");
    const payloadStart = result.indexOf("\n");
    const payload = result.slice(payloadStart + 1);
    expect(payload.length).toBeLessThanOrEqual(10);
    expect(payload).toBe("a".repeat(payload.length));
  });

  test("handles multibyte UTF-8 at byte boundary", () => {
    const text = "日本語のテスト\nsecond line\nthird line";
    const result = truncateOutput(text, { maxBytes: 30, maxLines: 5 });
    // First line is 7 chars but ~21 bytes in UTF-8; header + lines may exceed
    expect(result).toContain("[TRUNCATED: first ");
    const payloadStart = result.indexOf("\n");
    if (payloadStart >= 0) {
      const payload = result.slice(payloadStart + 1);
      // Should not contain replacement character mid-string from invalid split
      const withoutHeader = payload.replace(/^\n/, "");
      expect(withoutHeader).not.toMatch(/\uFFFD/);
    }
  });

  test("uses default limits when none provided", () => {
    const shortText = "a";
    const result = truncateOutput(shortText);
    expect(result).toBe(shortText);
  });

  test("handles empty string", () => {
    const result = truncateOutput("", { maxBytes: 100, maxLines: 10 });
    expect(result).toBe("");
  });

  test("handles text with exactly maxLines", () => {
    const text = "a\nb\nc";
    const result = truncateOutput(text, { maxBytes: 1000, maxLines: 3 });
    expect(result).toBe(text);
  });

  test("handles text with exactly maxBytes", () => {
    const text = "hello";
    const result = truncateOutput(text, {
      maxBytes: Buffer.byteLength(text, "utf-8"),
      maxLines: 10,
    });
    expect(result).toBe(text);
  });

  test("truncation header reports correct kept/total line counts", () => {
    const text = "one\ntwo\nthree\nfour\nfive";
    const result = truncateOutput(text, { maxBytes: 10000, maxLines: 2 });
    expect(result).toContain("[TRUNCATED: first 2 of 5 lines]");
  });

  test("byte truncation preserves the truncation header", () => {
    const text = "x".repeat(500);
    const result = truncateOutput(text, { maxBytes: 20, maxLines: 10 });
    expect(result.startsWith("[TRUNCATED: first 1 of 1 lines]\n")).toBe(true);
  });
});
