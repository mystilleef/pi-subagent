import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../src/agents.js";
import { discoverAgents, formatAgentList } from "../src/agents.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_OUTPUT_LINES,
  detectMessageError,
  getPiInvocation,
  getSubagentDepth,
  getSubagentOutputLimits,
  resolveAgentSkillArgs,
  subagentDepthEnv,
  truncateOutput,
  writePromptToTempFile,
} from "../src/utils.js";
import { makeTempDir, setupHooks } from "./helpers.js";

setupHooks();

test("formatAgentList", () => {
  const agents: AgentConfig[] = [
    {
      name: "a1",
      source: "user",
      description: "d1",
      systemPrompt: "",
      filePath: "a1.md",
    },
    {
      name: "a2",
      source: "project",
      description: "d2",
      systemPrompt: "",
      filePath: "a2.md",
    },
  ];
  const res1 = formatAgentList(agents, 1);
  expect(res1.text).toBe("a1 (user): d1");
  expect(res1.remaining).toBe(1);
  const res2 = formatAgentList(agents, 2);
  expect(res2.text).toBe("a1 (user): d1; a2 (project): d2");
  expect(res2.remaining).toBe(0);
  const res0 = formatAgentList([], 10);
  expect(res0.text).toBe("none");
});

test("utility helpers cover truncation, invocation, prompt files, depth, and message errors", async () => {
  expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(50_000);
  expect(DEFAULT_MAX_OUTPUT_LINES).toBe(500);
  const byLines = Array.from({ length: 501 }, (_v, i) => `line-${i}`).join(
    "\n",
  );
  const truncatedLines = truncateOutput(byLines);
  expect(truncatedLines).toContain("[TRUNCATED: first 500 of 501 lines]");
  expect(truncatedLines).not.toContain("line-500");
  const truncatedBytes = truncateOutput("é".repeat(50_000));
  expect(truncatedBytes).toContain("[TRUNCATED: first 1 of 1 lines]");
  expect(truncatedBytes).not.toContain("\uFFFD");
  expect(
    getSubagentOutputLimits({
      PI_SUBAGENT_MAX_OUTPUT_BYTES: "1234",
      PI_SUBAGENT_MAX_OUTPUT_LINES: "12",
    }),
  ).toEqual({ maxBytes: 1234, maxLines: 12 });
  expect(
    getSubagentOutputLimits({
      PI_SUBAGENT_MAX_OUTPUT_BYTES: "0",
      PI_SUBAGENT_MAX_OUTPUT_LINES: "invalid",
    }),
  ).toEqual({ maxBytes: 50_000, maxLines: 500 });
  const envLimited = truncateOutput("a\nb\nc", { maxBytes: 100, maxLines: 2 });
  expect(envLimited).toContain("[TRUNCATED: first 2 of 3 lines]");
  expect(envLimited).not.toContain("c");
  const scriptDir = await makeTempDir("pi-subagent-script-");
  const scriptPath = path.join(scriptDir, "pi-entry.js");
  await writeFile(scriptPath, "console.log('pi');\n");
  const originalArgv1 = process.argv[1] ?? "";
  process.argv[1] = scriptPath;
  try {
    expect(getPiInvocation(["--x"])).toEqual({
      command: process.execPath,
      args: [scriptPath, "--x"],
    });
  } finally {
    process.argv[1] = originalArgv1;
  }
  const promptFile = await writePromptToTempFile("agent name!*", "secret");
  expect(path.basename(promptFile.filePath)).toBe("prompt-agent_name_.md");
  expect(await writeFile(promptFile.filePath, "secret")).toBeUndefined(); // ensure it exists
  expect(await Bun.file(promptFile.filePath).text()).toBe("secret");
  const originalDepth = process.env.PI_SUBAGENT_DEPTH;
  try {
    const cases: Array<[string | undefined, number, string]> = [
      [undefined, 0, "1"],
      ["not-a-number", 0, "1"],
      ["Infinity", 0, "1"],
      ["-1", 0, "1"],
      ["-0.5", 0, "1"],
      ["0.9", 0, "1"],
      ["1.7", 1, "2"],
      ["2", 2, "3"],
    ];
    for (const [value, depth, nextDepth] of cases) {
      if (value === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = value;
      expect(getSubagentDepth()).toBe(depth);
      expect(subagentDepthEnv()).toEqual({ PI_SUBAGENT_DEPTH: nextDepth });
    }
  } finally {
    if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = originalDepth;
  }
  expect(
    detectMessageError([
      { role: "toolResult", content: [], isError: true },
    ] as unknown as Message[]),
  ).toBe(true);
  expect(
    detectMessageError([
      { role: "toolResult", content: [], isError: true },
      { role: "assistant", content: [{ type: "text", text: "recovered" }] },
    ] as unknown as Message[]),
  ).toBe(false);
});

test("getPiInvocation keeps custom non-generic runtimes", () => {
  const originalArgv1 = process.argv[1] ?? "";
  const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
  process.argv[1] = path.join(tmpdir(), "missing-pi-entry.js");
  Object.defineProperty(process, "execPath", {
    value: "/opt/custom/pi-runtime",
    configurable: true,
  });
  try {
    expect(getPiInvocation(["--json"])).toEqual({
      command: "/opt/custom/pi-runtime",
      args: ["--json"],
    });
  } finally {
    process.argv[1] = originalArgv1;
    if (originalExecPath)
      Object.defineProperty(process, "execPath", originalExecPath);
  }
});

test("resolveAgentSkillArgs reports skill discovery errors", async () => {
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {
    throw new Error("scan failed");
  };
  try {
    await expect(
      resolveAgentSkillArgs(process.cwd(), ["helper"]),
    ).resolves.toEqual({
      error: "Failed to discover skills: scan failed",
    });
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("discoverAgents preserves scope filtering and project override precedence", async () => {
  const root = await makeTempDir("pi-subagent-scope-");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "work", "nested");
  const userDir = path.join(agentDir, "agents");
  const projectDir = path.join(root, "work", ".pi", "agents");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(userDir, "same.md"),
    `---
name: same
description: User same
---
User prompt`,
  );
  await writeFile(
    path.join(userDir, "user-only.md"),
    `---
name: user-only
description: User only
---
User prompt`,
  );
  await writeFile(
    path.join(projectDir, "same.md"),
    `---
name: same
description: Project same
---
Project prompt`,
  );
  await writeFile(
    path.join(projectDir, "project-only.md"),
    `---
name: project-only
description: Project only
---
Project prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const userAgents = discoverAgents(cwd, "user").agents;
  const projectAgents = discoverAgents(cwd, "project").agents;
  const bothAgents = discoverAgents(cwd, "both").agents;
  expect(userAgents.find((a) => a.name === "same")?.source).toBe("user");
  expect(userAgents.some((a) => a.name === "project-only")).toBe(false);
  expect(projectAgents.find((a) => a.name === "same")?.source).toBe("project");
  expect(projectAgents.some((a) => a.name === "user-only")).toBe(false);
  expect(bothAgents.find((a) => a.name === "same")?.source).toBe("project");
  expect(bothAgents.some((a) => a.name === "user-only")).toBe(true);
  expect(bothAgents.some((a) => a.name === "project-only")).toBe(true);
});

test("discoverAgents tolerates missing, invalid, and unreadable entries", async () => {
  const root = await makeTempDir("pi-subagent-discover-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-without-agents");
  expect(discoverAgents(cwd, "user").agents).toEqual([]);
  const agentDirWithFile = path.join(root, "agent-with-file");
  await mkdir(agentDirWithFile, { recursive: true });
  await writeFile(path.join(agentDirWithFile, "agents"), "not a directory");
  process.env.PI_CODING_AGENT_DIR = agentDirWithFile;
  expect(discoverAgents(cwd, "user").agents).toEqual([]);
  const agentDirWithBrokenLink = path.join(root, "agent-with-broken-link");
  const agentsDir = path.join(agentDirWithBrokenLink, "agents");
  await mkdir(agentsDir, { recursive: true });
  await symlink(
    path.join(agentsDir, "missing.md"),
    path.join(agentsDir, "broken.md"),
  );
  await writeFile(
    path.join(agentsDir, "missing-description.md"),
    `---
name: invalid
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "invalid-yaml.md"),
    `---
name: [unterminated
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-object.md"),
    `---
- name
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-name.md"),
    `---
name: 1
description: Bad name
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-description.md"),
    `---
name: bad-description
description: 1
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-tools.md"),
    `---
name: bad-tools
description: Bad tools
tools:
  - bash
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-skills.md"),
    `---
name: bad-skills
description: Bad skills
skills:
  - helper
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-thinking.md"),
    `---
name: bad-thinking
description: Bad thinking
thinking: 1
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "empty-options.md"),
    `---
name: empty-options
description: Empty options
tools: " , "
skills:
thinking: louder
---
Prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDirWithBrokenLink;
  const agents = discoverAgents(cwd, "user").agents;
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({
    name: "empty-options",
    tools: undefined,
    skills: [],
    thinking: undefined,
  });
});

test("resolveAgentSkillArgs maps duplicate skill names to file paths", async () => {
  const root = await makeTempDir("pi-subagent-skills-");
  const cwd = path.join(root, "work");
  const skillDir = path.join(cwd, ".pi", "skills", "helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: helper
description: Helps tests
---
# Helper
`,
  );
  const resolved = await resolveAgentSkillArgs(cwd, ["helper", "helper"]);
  expect("args" in resolved).toBe(true);
  if ("args" in resolved) {
    expect(resolved.args).toEqual(["--skill", path.join(skillDir, "SKILL.md")]);
  }
});
