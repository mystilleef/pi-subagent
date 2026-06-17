import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendWithByteLimit,
  resolveCompleteExtensionPath,
  resolveContextWindowTokens,
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
  test("appends string data within byte limit", () => {
    const result = appendWithByteLimit("abc", "def", 1024);
    expect(result).toBe("abcdef");
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

  test("returns current when already exceeding byte limit", () => {
    const current = "abcdef";
    const result = appendWithByteLimit(current, "ghi", 3);
    expect(result).toBe("abcdef");
  });

  test("truncates at byte limit preserving valid UTF-8", () => {
    const result = appendWithByteLimit("abc", "defghijklmno", 8);
    expect(result).toBe("abcdefgh");
  });

  test("handles empty current with incoming data", () => {
    const result = appendWithByteLimit("", "hello", 1024);
    expect(result).toBe("hello");
  });

  test("handles empty incoming data", () => {
    const result = appendWithByteLimit("hello", "", 1024);
    expect(result).toBe("hello");
  });

  test("handles multi-byte UTF-8 truncation at boundary", () => {
    const current = "ab";
    const data = "€€€"; // each € is 3 bytes in UTF-8
    const max = 5; // 2 (current) + 3 (one €) = 5 bytes
    const result = appendWithByteLimit(current, data, max);
    expect(result).toBe("ab€");
  });

  test("returns empty string when max is 0", () => {
    const current = "";
    const result = appendWithByteLimit(current, "abc", 0);
    expect(result).toBe("");
  });
});

describe("truncateValidUtf8", () => {
  test("returns full buffer when within limit", () => {
    const buf = Buffer.from("hello", "utf-8");
    const result = truncateValidUtf8(buf, 1024);
    expect(result).toBe("hello");
  });

  test("truncates at exact byte boundary", () => {
    const buf = Buffer.from("abcdef", "utf-8");
    const result = truncateValidUtf8(buf, 3);
    expect(result).toBe("abc");
  });

  test("truncates at multi-byte character boundary by stepping back", () => {
    const buf = Buffer.from("ab€cd", "utf-8"); // a(1) b(1) €(3) c(1) d(1) = 7 bytes
    const result = truncateValidUtf8(buf, 4); // would split €
    expect(result).toBe("ab");
  });

  test("returns empty string when max is 0 and buffer starts with multi-byte", () => {
    const buf = Buffer.from("€", "utf-8");
    const result = truncateValidUtf8(buf, 0);
    expect(result).toBe("");
  });

  test("returns empty string when max is less than first char bytes", () => {
    const buf = Buffer.from("€abc", "utf-8"); // € is 3 bytes
    const result = truncateValidUtf8(buf, 2); // less than 3
    expect(result).toBe("");
  });

  test("handles max larger than buffer length", () => {
    const buf = Buffer.from("hi", "utf-8");
    const result = truncateValidUtf8(buf, 100);
    expect(result).toBe("hi");
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

  test("returns undefined when getModel throws an error", async () => {
    mock.module("@earendil-works/pi-ai", () => ({
      getModel: () => {
        throw new Error("Mocked model lookup failure");
      },
    }));
    const mod = await import("../src/child/process-utils.js");
    const msg = { provider: "openai", model: "gpt-4" } as unknown as Parameters<
      typeof resolveContextWindowTokens
    >[0];
    expect(mod.resolveContextWindowTokens(msg)).toBeUndefined();
    mock.restore();
  });
});
