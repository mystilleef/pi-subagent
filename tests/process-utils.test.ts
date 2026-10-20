import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendWithByteLimit,
  resolveCompleteExtensionPath,
  resolveContextWindowTokens,
  resolvePackageExtensionPath,
  resolveSamplingExtensionPath,
  truncateValidUtf8,
} from "../src/child/process-utils.js";

describe("resolveCompleteExtensionPath", () => {
  test("returns path containing complete-extension from default dir", () => {
    const result = resolveCompleteExtensionPath();
    expect(result).toContain("complete-extension");
    expect(fs.existsSync(result)).toBe(true);
  });

  test("throws when neither .ts nor .js exists in given dir", () => {
    expect(() =>
      resolveCompleteExtensionPath("/tmp/nonexistent-pi-subagent-dir-xyz"),
    ).toThrow("complete-extension not found");
  });

  test("returns .js path when only .js exists in dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
    const jsPath = path.join(dir, "complete-extension.js");
    fs.writeFileSync(jsPath, "");
    try {
      const result = resolveCompleteExtensionPath(dir);
      expect(result).toBe(jsPath);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("throw message includes both candidate paths", () => {
    const dir = "/tmp/nonexistent-pi-subagent-dir-xyz";
    expect(() => resolveCompleteExtensionPath(dir)).toThrow(dir);
  });
});

describe("appendWithByteLimit", () => {
  test.each([
    {
      name: "appends string data within byte limit",
      current: "abc",
      incoming: "def",
      maxBytes: 1024,
      expected: "abcdef",
    },
    {
      name: "truncates at byte limit preserving valid UTF-8",
      current: "abc",
      incoming: "defghijklmno",
      maxBytes: 8,
      expected: "abcdefgh",
    },
    {
      name: "handles empty current with incoming data",
      current: "",
      incoming: "hello",
      maxBytes: 1024,
      expected: "hello",
    },
    {
      name: "handles empty incoming data",
      current: "hello",
      incoming: "",
      maxBytes: 1024,
      expected: "hello",
    },
  ])("$name", (row) => {
    const result = appendWithByteLimit(row.current, row.incoming, row.maxBytes);
    expect(result).toBe(row.expected);
  });

  test("appends Buffer data within byte limit", () => {
    const result = appendWithByteLimit("abc", Buffer.from("def"), 1024);
    expect(result).toBe("abcdef");
  });

  test("returns current when already at byte limit", () => {
    const current = "abc";
    const result = appendWithByteLimit(
      current,
      "def",
      Buffer.from(current).length,
    );
    expect(result).toBe("abc");
  });

  test.each([
    {
      name: "returns current when already exceeding byte limit",
      current: "abcdef",
      incoming: "ghi",
      maxBytes: 3,
      expected: "abcdef",
    },
    {
      name: "returns empty string when max is 0",
      current: "",
      incoming: "abc",
      maxBytes: 0,
      expected: "",
    },
  ])("$name", (row) => {
    const current = row.current;
    const result = appendWithByteLimit(current, row.incoming, row.maxBytes);
    expect(result).toBe(row.expected);
  });

  test("handles multi-byte UTF-8 truncation at boundary", () => {
    const current = "ab";
    const data = "€€€"; // each € is 3 bytes in UTF-8
    const max = 5; // 2 (current) + 3 (one €) = 5 bytes
    const result = appendWithByteLimit(current, data, max);
    expect(result).toBe("ab€");
  });
});

describe("truncateValidUtf8", () => {
  test.each([
    {
      name: "returns full buffer when within limit",
      text: "hello",
      maxBytes: 1024,
      expected: "hello",
    },
    {
      name: "truncates at exact byte boundary",
      text: "abcdef",
      maxBytes: 3,
      expected: "abc",
    },
    {
      name: "returns empty string when max is 0 and buffer starts with multi-byte",
      text: "€",
      maxBytes: 0,
      expected: "",
    },
    {
      name: "handles max larger than buffer length",
      text: "hi",
      maxBytes: 100,
      expected: "hi",
    },
  ])("$name", (row) => {
    const buf = Buffer.from(row.text, "utf-8");
    const result = truncateValidUtf8(buf, row.maxBytes);
    expect(result).toBe(row.expected);
  });

  test("truncates at multi-byte character boundary by stepping back", () => {
    const buf = Buffer.from("ab€cd", "utf-8"); // a(1) b(1) €(3) c(1) d(1) = 7 bytes
    const result = truncateValidUtf8(buf, 4); // would split €
    expect(result).toBe("ab");
  });

  test("returns empty string when max is less than first char bytes", () => {
    const buf = Buffer.from("€abc", "utf-8"); // € is 3 bytes
    const result = truncateValidUtf8(buf, 2); // less than 3
    expect(result).toBe("");
  });

  test("handles sequences of multi-byte characters", () => {
    const buf = Buffer.from("€€€", "utf-8"); // 9 bytes
    const result = truncateValidUtf8(buf, 7);
    expect(result).toBe("€€"); // 6 bytes, 2 chars
  });

  test("returns empty string when the buffer contains no valid truncation point", () => {
    const buf = Buffer.from([0xff, 0xff, 0xff]);
    expect(truncateValidUtf8(buf, 2)).toBe("");
  });
});

describe("resolvePackageExtensionPath", () => {
  test("returns path pointing to index extension from default dir", () => {
    const result = resolvePackageExtensionPath();
    const ext = __filename.endsWith(".ts") ? ".ts" : ".js";
    expect(result).toEndWith(`index${ext}`);
    expect(fs.existsSync(result)).toBe(true);
  });

  test("throws when neither .ts nor .js exists at resolved path", () => {
    const nested = path.join(
      os.tmpdir(),
      "pi-subagent-test-nested",
      "deep",
      "child",
    );
    fs.mkdirSync(nested, { recursive: true });
    try {
      expect(() => resolvePackageExtensionPath(nested)).toThrow(
        "index not found",
      );
    } finally {
      fs.rmSync(path.join(os.tmpdir(), "pi-subagent-test-nested"), {
        recursive: true,
        force: true,
      });
    }
  });

  test("returns .js path when only .js exists at resolved path", () => {
    const nested = path.join(
      os.tmpdir(),
      "pi-subagent-test-js",
      "deep",
      "child",
    );
    const parentDir = path.join(os.tmpdir(), "pi-subagent-test-js", "deep");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(parentDir, { recursive: true });
    const jsPath = path.join(parentDir, "index.js");
    fs.writeFileSync(jsPath, "");
    try {
      const result = resolvePackageExtensionPath(nested);
      expect(result).toBe(jsPath);
    } finally {
      fs.rmSync(path.join(os.tmpdir(), "pi-subagent-test-js"), {
        recursive: true,
        force: true,
      });
    }
  });

  test("throw message includes both candidate paths", () => {
    const nested = path.join(
      os.tmpdir(),
      "pi-subagent-test-missing",
      "deep",
      "child",
    );
    fs.mkdirSync(nested, { recursive: true });
    try {
      expect(() => resolvePackageExtensionPath(nested)).toThrow("not found");
    } finally {
      fs.rmSync(path.join(os.tmpdir(), "pi-subagent-test-missing"), {
        recursive: true,
        force: true,
      });
    }
  });

  test("returns .ts path when .ts exists at resolved path", () => {
    const nested = path.join(
      os.tmpdir(),
      "pi-subagent-test-ts",
      "deep",
      "child",
    );
    const parentDir = path.join(os.tmpdir(), "pi-subagent-test-ts", "deep");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(parentDir, { recursive: true });
    const tsPath = path.join(parentDir, "index.ts");
    fs.writeFileSync(tsPath, "");
    try {
      const result = resolvePackageExtensionPath(nested);
      expect(result).toBe(tsPath);
    } finally {
      fs.rmSync(path.join(os.tmpdir(), "pi-subagent-test-ts"), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe("resolveSamplingExtensionPath", () => {
  test("returns path containing sampling-extension from default dir", () => {
    const result = resolveSamplingExtensionPath();
    expect(result).toContain("sampling-extension");
    expect(fs.existsSync(result)).toBe(true);
  });

  test("throws when neither .ts nor .js exists in given dir", () => {
    expect(() =>
      resolveSamplingExtensionPath("/tmp/nonexistent-pi-subagent-dir-xyz"),
    ).toThrow("sampling-extension not found");
  });
});

describe("resolveContextWindowTokens", () => {
  test("returns undefined when provider is not a string", () => {
    const msg = { provider: 123, model: "gpt-4" } as unknown as Parameters<
      typeof resolveContextWindowTokens
    >[0];
    expect(resolveContextWindowTokens(msg)).toBeUndefined();
  });

  test("returns undefined when model is not a string", () => {
    const msg = { provider: "openai", model: 456 } as unknown as Parameters<
      typeof resolveContextWindowTokens
    >[0];
    expect(resolveContextWindowTokens(msg)).toBeUndefined();
  });

  test("returns undefined when provider is missing", () => {
    const msg = { model: "gpt-4" } as unknown as Parameters<
      typeof resolveContextWindowTokens
    >[0];
    expect(resolveContextWindowTokens(msg)).toBeUndefined();
  });

  test("returns undefined when model is missing", () => {
    const msg = { provider: "openai" } as unknown as Parameters<
      typeof resolveContextWindowTokens
    >[0];
    expect(resolveContextWindowTokens(msg)).toBeUndefined();
  });

  test("returns context window for a valid model with positive context window", () => {
    const msg = { provider: "openai", model: "gpt-4" } as unknown as Parameters<
      typeof resolveContextWindowTokens
    >[0];
    const tokens = resolveContextWindowTokens(msg);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isFinite(tokens)).toBe(true);
  });

  test("returns undefined for a model with zero context window", () => {
    const msg = {
      provider: "nonexistent",
      model: "no-model",
    } as unknown as Parameters<typeof resolveContextWindowTokens>[0];
    expect(resolveContextWindowTokens(msg)).toBeUndefined();
  });

  test("returns context window for google model", () => {
    const msg = {
      provider: "google",
      model: "gemini-2.5-pro",
    } as unknown as Parameters<typeof resolveContextWindowTokens>[0];
    const tokens = resolveContextWindowTokens(msg);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isFinite(tokens)).toBe(true);
  });
});
