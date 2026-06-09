import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { getPiInvocation, writePromptToTempFile } from "../src/shared/utils.js";

describe("utils.ts uncovered branches", () => {
  describe("writePromptToTempFile", () => {
    test("sanitizes agent name with special characters", async () => {
      const result = await writePromptToTempFile(
        "test agent!",
        "prompt content",
      );
      expect(result.dir).toBeDefined();
      expect(result.filePath).toContain("prompt-test_agent_.md");
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });

    test("sanitizes agent name with spaces", async () => {
      const result = await writePromptToTempFile("my agent name", "prompt");
      expect(result.filePath).toContain("prompt-my_agent_name.md");
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });

    test("preserves alphanumeric and dots", async () => {
      const result = await writePromptToTempFile("agent.v1", "prompt");
      expect(result.filePath).toContain("prompt-agent.v1.md");
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });

    test("preserves hyphens and underscores", async () => {
      const result = await writePromptToTempFile("my-agent_v2", "prompt");
      expect(result.filePath).toContain("prompt-my-agent_v2.md");
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });

    test("writes prompt with correct permissions", async () => {
      const result = await writePromptToTempFile("test", "content");
      const stats = await fs.promises.stat(result.filePath);
      expect(stats.mode & 0o777).toBe(0o600);
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });

    test("writes prompt content correctly", async () => {
      const content = "# Test\n\nThis is a test prompt.";
      const result = await writePromptToTempFile("test", content);
      const written = await fs.promises.readFile(result.filePath, "utf-8");
      expect(written).toBe(content);
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });
  });

  describe("getPiInvocation", () => {
    test("returns execPath with current script when script exists", () => {
      const originalArgv1 = process.argv[1];
      process.argv[1] = import.meta.path;
      const result = getPiInvocation(["arg1", "arg2"]);
      expect(result.command).toBe(process.execPath);
      expect(result.args).toContain(import.meta.path);
      expect(result.args).toContain("arg1");
      expect(result.args).toContain("arg2");
      if (originalArgv1 !== undefined) {
        process.argv[1] = originalArgv1;
      }
    });

    test("includes all provided args", () => {
      const args = ["--verbose", "--config", "test.json"];
      const result = getPiInvocation(args);
      args.forEach((arg) => {
        expect(result.args).toContain(arg);
      });
    });
  });
});
