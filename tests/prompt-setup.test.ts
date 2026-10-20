import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { writePromptToTempFile } from "../src/shared/utils.js";
import { setupHooks } from "./helpers.js";

setupHooks();

describe("utils.ts coverage gaps", () => {
  test("writePromptToTempFile creates temp file with sanitized agent name", async () => {
    const prompt = "Test prompt content";
    const result = await writePromptToTempFile("test-agent", prompt);

    expect(result.dir).toBeDefined();
    expect(result.filePath).toBeDefined();
    expect(result.filePath).toContain("prompt-test-agent.md");

    // Verify file was created with correct content
    const content = await fs.promises.readFile(result.filePath, "utf-8");
    expect(content).toBe(prompt);

    // Verify file permissions
    const stat = await fs.promises.stat(result.filePath);
    const mode = (stat.mode & 0o777).toString(8);
    expect(mode).toBe("600");

    // Cleanup
    await fs.promises.unlink(result.filePath);
    await fs.promises.rmdir(result.dir);
  });
});

describe("utils.ts coverage gaps", () => {
  test("writePromptToTempFile sanitizes special characters in agent name", async () => {
    const prompt = "Test prompt";
    const result = await writePromptToTempFile(
      "agent with spaces!@#$%",
      prompt,
    );

    expect(result.filePath).toContain("prompt-agent_with_spaces_.md");

    // Cleanup
    await fs.promises.unlink(result.filePath);
    await fs.promises.rmdir(result.dir);
  });
});
