import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { writePromptToTempFile } from "../src/child/prompt-setup.js";
import { setupFixtureHooks } from "./fixtures.js";

setupFixtureHooks();

describe("writePromptToTempFile", () => {
  test("writePromptToTempFile creates temp file with sanitized agent name", async () => {
    const prompt = "Test prompt content";
    const result = await writePromptToTempFile("test-agent", prompt);
    expect(result.dir).toBeDefined();
    expect(result.filePath).toBeDefined();
    expect(result.filePath).toContain("prompt-test-agent.md");
    const content = await fs.promises.readFile(result.filePath, "utf-8");
    expect(content).toBe(prompt);
    const stat = await fs.promises.stat(result.filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    await fs.promises.unlink(result.filePath);
    await fs.promises.rmdir(result.dir);
  });

  test("writePromptToTempFile sanitizes special characters in agent name", async () => {
    const prompt = "Test prompt";
    const result = await writePromptToTempFile(
      "agent with spaces!@#$%",
      prompt,
    );
    expect(result.filePath).toContain("prompt-agent_with_spaces_.md");
    await fs.promises.unlink(result.filePath);
    await fs.promises.rmdir(result.dir);
  });

  test.each([
    {
      name: "sanitizes agent name with spaces",
      agentName: "my agent name",
      expectedFileName: "prompt-my_agent_name.md",
    },
    {
      name: "preserves alphanumeric and dots",
      agentName: "agent.v1",
      expectedFileName: "prompt-agent.v1.md",
    },
    {
      name: "preserves hyphens and underscores",
      agentName: "my-agent_v2",
      expectedFileName: "prompt-my-agent_v2.md",
    },
  ])("$name", async (row) => {
    const result = await writePromptToTempFile(row.agentName, "prompt");
    expect(result.filePath).toContain(row.expectedFileName);
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

  test("cleanup removes temp directory after prompt creation", async () => {
    const result = await writePromptToTempFile("agent name!*", "secret");
    expect(path.basename(result.filePath)).toBe("prompt-agent_name_.md");
    expect(await fs.promises.readFile(result.filePath, "utf-8")).toBe("secret");
    await fs.promises.rm(result.dir, { recursive: true, force: true });
    await expect(fs.promises.stat(result.dir)).rejects.toThrow();
  });
});
