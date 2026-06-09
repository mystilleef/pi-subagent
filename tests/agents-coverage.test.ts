import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  discoverAgentsAsync,
  formatAgentList,
  isDirectoryAsync,
  readMarkdownDirWithStatusAsync,
} from "../src/agent/agents.js";
import { setupFakePi } from "./helpers.js";

describe("agents.ts error handling and edge cases", () => {
  describe("parseAgentConfig error paths", () => {
    test("malformed frontmatter returns null", async () => {
      const { agentDir, cwd } = await setupFakePi();
      const userDir = path.join(agentDir, "agents");
      await writeFile(
        path.join(userDir, "bad-frontmatter.md"),
        `---
this is not valid yaml: [
  unclosed bracket
---
body content`,
      );
      const discovery = await discoverAgentsAsync(cwd, "user");
      expect(
        discovery.agents.find((a) => a.name === "bad-frontmatter"),
      ).toBeUndefined();
    });

    test("frontmatter that is array returns null", async () => {
      const { agentDir, cwd } = await setupFakePi();
      const userDir = path.join(agentDir, "agents");
      await writeFile(
        path.join(userDir, "array-frontmatter.md"),
        `---
- item1
- item2
---
body`,
      );
      const discovery = await discoverAgentsAsync(cwd, "user");
      expect(
        discovery.agents.find((a) => a.name === "array-frontmatter"),
      ).toBeUndefined();
    });

    test("tools field that is not string returns null", async () => {
      const { agentDir, cwd } = await setupFakePi();
      const userDir = path.join(agentDir, "agents");
      await writeFile(
        path.join(userDir, "bad-tools.md"),
        `---
name: bad-tools
description: Tools as number
tools: 123
---
body`,
      );
      const discovery = await discoverAgentsAsync(cwd, "user");
      expect(
        discovery.agents.find((a) => a.name === "bad-tools"),
      ).toBeUndefined();
    });

    test("skills field that is not string returns null", async () => {
      const { agentDir, cwd } = await setupFakePi();
      const userDir = path.join(agentDir, "agents");
      await writeFile(
        path.join(userDir, "bad-skills.md"),
        `---
name: bad-skills
description: Skills as object
skills:
  nested: value
---
body`,
      );
      const discovery = await discoverAgentsAsync(cwd, "user");
      expect(
        discovery.agents.find((a) => a.name === "bad-skills"),
      ).toBeUndefined();
    });

    test("thinking field that is not string returns null", async () => {
      const { agentDir, cwd } = await setupFakePi();
      const userDir = path.join(agentDir, "agents");
      await writeFile(
        path.join(userDir, "bad-thinking.md"),
        `---
name: bad-thinking
description: Thinking as boolean
thinking: true
---
body`,
      );
      const discovery = await discoverAgentsAsync(cwd, "user");
      expect(
        discovery.agents.find((a) => a.name === "bad-thinking"),
      ).toBeUndefined();
    });
  });

  describe("loadAgentEntryAsync error paths", () => {
    test("unreadable file returns null and skips agent", async () => {
      const { agentDir, cwd } = await setupFakePi();
      const userDir = path.join(agentDir, "agents");
      const unreadablePath = path.join(userDir, "unreadable.md");
      await writeFile(
        unreadablePath,
        `---
name: unreadable
description: Cannot read this
---
body`,
      );
      await chmod(unreadablePath, 0o000);
      const discovery = await discoverAgentsAsync(cwd, "user");
      expect(
        discovery.agents.find((a) => a.name === "unreadable"),
      ).toBeUndefined();
      await chmod(unreadablePath, 0o644);
    });
  });

  describe("readMarkdownDirWithStatusAsync", () => {
    test("null directory returns empty listing with ok true", async () => {
      const result = await readMarkdownDirWithStatusAsync(null);
      expect(result.entries).toEqual([]);
      expect(result.ok).toBe(true);
    });

    test("non-existent directory returns empty listing with ok false", async () => {
      const result = await readMarkdownDirWithStatusAsync(
        "/nonexistent/path/that/does/not/exist",
      );
      expect(result.entries).toEqual([]);
      expect(result.ok).toBe(false);
    });

    test("inaccessible directory returns empty listing with ok false", async () => {
      const { agentDir } = await setupFakePi();
      const inaccessibleDir = path.join(agentDir, "inaccessible");
      await mkdir(inaccessibleDir, { recursive: true });
      await chmod(inaccessibleDir, 0o000);
      const result = await readMarkdownDirWithStatusAsync(inaccessibleDir);
      expect(result.entries).toEqual([]);
      expect(result.ok).toBe(false);
      await chmod(inaccessibleDir, 0o755);
    });
  });

  describe("isDirectoryAsync", () => {
    test("non-existent path returns false", async () => {
      const result = await isDirectoryAsync("/nonexistent/path");
      expect(result).toBe(false);
    });

    test("inaccessible path returns false", async () => {
      const { agentDir } = await setupFakePi();
      const inaccessiblePath = path.join(agentDir, "inaccessible-stat");
      await mkdir(inaccessiblePath, { recursive: true });
      await chmod(inaccessiblePath, 0o000);
      const result = await isDirectoryAsync(
        path.join(inaccessiblePath, "subdir"),
      );
      expect(result).toBe(false);
      await chmod(inaccessiblePath, 0o755);
    });
  });

  describe("formatAgentList", () => {
    test("empty agents list returns none with zero remaining", () => {
      const result = formatAgentList([], 10);
      expect(result.text).toBe("none");
      expect(result.remaining).toBe(0);
    });

    test("agents within maxItems shows all with zero remaining", () => {
      const agents = [
        {
          name: "agent1",
          description: "First agent",
          source: "user" as const,
          systemPrompt: "prompt1",
          filePath: "/path/1",
        },
        {
          name: "agent2",
          description: "Second agent",
          source: "project" as const,
          systemPrompt: "prompt2",
          filePath: "/path/2",
        },
      ];
      const result = formatAgentList(agents, 10);
      expect(result.text).toBe(
        "agent1 (user): First agent; agent2 (project): Second agent",
      );
      expect(result.remaining).toBe(0);
    });

    test("agents exceeding maxItems shows truncated list with remaining count", () => {
      const agents = [
        {
          name: "agent1",
          description: "First agent",
          source: "user" as const,
          systemPrompt: "prompt1",
          filePath: "/path/1",
        },
        {
          name: "agent2",
          description: "Second agent",
          source: "project" as const,
          systemPrompt: "prompt2",
          filePath: "/path/2",
        },
        {
          name: "agent3",
          description: "Third agent",
          source: "user" as const,
          systemPrompt: "prompt3",
          filePath: "/path/3",
        },
      ];
      const result = formatAgentList(agents, 2);
      expect(result.text).toBe(
        "agent1 (user): First agent; agent2 (project): Second agent",
      );
      expect(result.remaining).toBe(1);
    });
  });
});
