import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import {
  beginPromptSetup,
  cleanupPromptSetupResult,
  cleanupTempPrompt,
  writePromptToTempFile,
} from "../src/child/prompt-setup.js";
import { makeModelAgent, setupFixtureHooks } from "./fixtures.js";

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

describe("cleanupTempPrompt", () => {
  test("cleanupTempPrompt removes the temp file and its directory", async () => {
    const result = await writePromptToTempFile("cleanup", "prompt");
    await cleanupTempPrompt(result);
    await expect(fs.promises.stat(result.filePath)).rejects.toThrow();
    await expect(fs.promises.stat(result.dir)).rejects.toThrow();
  });

  test("cleanupTempPrompt swallows a failed unlink and still resolves", async () => {
    const denied = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const unlinkSpy = spyOn(fs.promises, "unlink").mockRejectedValue(denied);
    const result = await writePromptToTempFile("swallow", "prompt");

    await expect(cleanupTempPrompt(result)).resolves.toBeUndefined();
    expect(unlinkSpy).toHaveBeenCalledWith(result.filePath);

    unlinkSpy.mockRestore();
    await fs.promises.rm(result.dir, { recursive: true, force: true });
  });
});

describe("beginPromptSetup", () => {
  test("beginPromptSetup returns a null tmpPrompt for a blank system prompt", async () => {
    const mkdtempSpy = spyOn(fs.promises, "mkdtemp");
    const agent = makeModelAgent({ systemPrompt: "  \n\t " });

    await expect(beginPromptSetup(agent)).resolves.toEqual({ tmpPrompt: null });
    expect(mkdtempSpy).not.toHaveBeenCalled();
  });

  test("beginPromptSetup writes the system prompt to a temp file", async () => {
    const agent = makeModelAgent({
      name: "setup-agent",
      systemPrompt: "System prompt body.",
    });

    const result = await beginPromptSetup(agent);
    if (!("tmpPrompt" in result) || !result.tmpPrompt) {
      throw new Error("expected a temp prompt");
    }
    expect(result.tmpPrompt.filePath).toContain("prompt-setup-agent.md");
    expect(await fs.promises.readFile(result.tmpPrompt.filePath, "utf-8")).toBe(
      "System prompt body.",
    );
    await fs.promises.rm(result.tmpPrompt.dir, {
      recursive: true,
      force: true,
    });
  });

  test("beginPromptSetup returns the error when the write fails", async () => {
    const denied = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const workDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pi-subagent-test-"),
    );
    spyOn(fs.promises, "mkdtemp").mockResolvedValue(workDir);
    const writeFileSpy = spyOn(fs.promises, "writeFile").mockRejectedValue(
      denied,
    );

    const agent = makeModelAgent({ name: "failing", systemPrompt: "Body" });
    await expect(beginPromptSetup(agent)).resolves.toEqual({ error: denied });
    expect(writeFileSpy).toHaveBeenCalledWith(
      path.join(workDir, "prompt-failing.md"),
      "Body",
      { encoding: "utf-8", mode: 0o600 },
    );

    await fs.promises.rm(workDir, { recursive: true, force: true });
  });
});

describe("cleanupPromptSetupResult", () => {
  test("cleanupPromptSetupResult removes the temp file and directory", async () => {
    const result = await writePromptToTempFile("setup-result", "prompt");

    await cleanupPromptSetupResult({ tmpPrompt: result });

    await expect(fs.promises.stat(result.filePath)).rejects.toThrow();
    await expect(fs.promises.stat(result.dir)).rejects.toThrow();
  });
});
