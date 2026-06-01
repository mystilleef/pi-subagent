import { expect, test } from "bun:test";
import { chmod, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  AGENT_DISCOVERY_CACHE_TTL_MS,
  type AgentDiscoveryCache,
  getCachedAgentCompletions,
  getCachedAgentDiscovery,
  resetAgentDiscoveryCache,
} from "../src/agent/agent-cache.js";
import type { AgentConfig } from "../src/agent/agents.js";
import { discoverAgentsAsync, formatAgentList } from "../src/agent/agents.js";
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
} from "../src/shared/utils.js";
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
  const userDiscovery = await discoverAgentsAsync(cwd, "user");
  const projectDiscovery = await discoverAgentsAsync(cwd, "project");
  const bothDiscovery = await discoverAgentsAsync(cwd, "both");
  const userAgents = userDiscovery.agents;
  const projectAgents = projectDiscovery.agents;
  const bothAgents = bothDiscovery.agents;
  expect(userAgents.find((a) => a.name === "same")?.source).toBe("user");
  expect(userAgents.some((a) => a.name === "project-only")).toBe(false);
  expect(projectAgents.find((a) => a.name === "same")?.source).toBe("project");
  expect(projectAgents.some((a) => a.name === "user-only")).toBe(false);
  expect(bothAgents.find((a) => a.name === "same")?.source).toBe("project");
  expect(bothAgents.some((a) => a.name === "user-only")).toBe(true);
  expect(bothAgents.some((a) => a.name === "project-only")).toBe(true);
  expect(userDiscovery.scopes.project).toEqual({
    agents: [],
    markdownFiles: [],
  });
  expect(projectDiscovery.scopes.user).toEqual({
    agents: [],
    markdownFiles: [],
  });
  expect(
    bothDiscovery.scopes.user.agents.map((a) => `${a.name}:${a.source}`).sort(),
  ).toEqual(["same:user", "user-only:user"]);
  expect(
    bothDiscovery.scopes.project.agents
      .map((a) => `${a.name}:${a.source}`)
      .sort(),
  ).toEqual(["project-only:project", "same:project"]);
  expect([...bothDiscovery.scopes.user.markdownFiles].sort()).toEqual([
    "same.md",
    "user-only.md",
  ]);
  expect([...bothDiscovery.scopes.project.markdownFiles].sort()).toEqual([
    "project-only.md",
    "same.md",
  ]);
});

test("agent discovery cache separates cwd and scope, reuses completions, and expires", async () => {
  const root = await makeTempDir("pi-subagent-cache-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwdA = path.join(root, "a");
  const cwdB = path.join(root, "b");
  const projectDirA = path.join(cwdA, ".pi", "agents");
  const projectDirB = path.join(cwdB, ".pi", "agents");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDirA, { recursive: true });
  await mkdir(projectDirB, { recursive: true });
  await writeFile(
    path.join(userDir, "user.md"),
    `---
name: user
description: User
---
User prompt`,
  );
  await writeFile(
    path.join(projectDirA, "project-a.md"),
    `---
name: project-a
description: Project A
---
Project A prompt`,
  );
  await writeFile(
    path.join(projectDirB, "project-b.md"),
    `---
name: project-b
description: Project B
---
Project B prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  let now = 1000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    expect(AGENT_DISCOVERY_CACHE_TTL_MS).toBe(300_000);
    const bothA = await getCachedAgentDiscovery(cwdA, "both", cache, 3000);
    const projectA = await getCachedAgentDiscovery(
      cwdA,
      "project",
      cache,
      3000,
    );
    const bothB = await getCachedAgentDiscovery(cwdB, "both", cache, 3000);
    expect(bothA.agents.map((agent) => agent.name).sort()).toEqual([
      "project-a",
      "user",
    ]);
    expect(projectA.agents.map((agent) => agent.name)).toEqual(["project-a"]);
    expect(bothB.agents.map((agent) => agent.name).sort()).toEqual([
      "project-b",
      "user",
    ]);
    expect(cache.size).toBe(6);
    expect(
      await getCachedAgentCompletions("project", cwdA, cache, 3000),
    ).toEqual([{ value: "project-a", label: "project-a" }]);
    await writeFile(
      path.join(projectDirA, "project-c.md"),
      `---
name: project-c
description: Project C
---
Project C prompt`,
    );
    expect(await getCachedAgentDiscovery(cwdA, "both", cache, 3000)).toBe(
      bothA,
    );
    now += 3001;
    expect(
      (await getCachedAgentDiscovery(cwdA, "both", cache, 3000)).agents.some(
        (agent) => agent.name === "project-c",
      ),
    ).toBe(true);
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache derives scoped entries from trusted both discovery", async () => {
  const root = await makeTempDir("pi-subagent-derived-cache-");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "work");
  const userDir = path.join(agentDir, "agents");
  const projectDir = path.join(cwd, ".pi", "agents");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
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
  const cache: AgentDiscoveryCache = new Map();
  let now = 5000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    expect(cache.size).toBe(3);
    now += 1;
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    const project = await getCachedAgentDiscovery(cwd, "project", cache, 3000);
    expect(user.ts).toBe(both.ts);
    expect(project.ts).toBe(both.ts);
    expect(both.agents.find((agent) => agent.name === "same")?.source).toBe(
      "project",
    );
    expect(
      user.agents.map((agent) => `${agent.name}:${agent.source}`).sort(),
    ).toEqual(["same:user", "user-only:user"]);
    expect(
      project.agents.map((agent) => `${agent.name}:${agent.source}`).sort(),
    ).toEqual(["project-only:project", "same:project"]);
    expect(user.scopes.project).toEqual({ agents: [], markdownFiles: [] });
    expect(project.scopes.user).toEqual({ agents: [], markdownFiles: [] });
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache falls back when derived listing or content changes", async () => {
  const root = await makeTempDir("pi-subagent-derived-cache-stale-");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "work");
  const userDir = path.join(agentDir, "agents");
  const userKey = `${path.resolve(cwd)}\0user`;
  await mkdir(userDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(userDir, "reviewer.md"),
    `---
name: reviewer
description: Reviewer
---
Old prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  let now = 7000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    cache.delete(userKey);
    await writeFile(
      path.join(userDir, "reviewer.md"),
      `---
name: reviewer-new
description: Reviewer new
---
New prompt`,
    );
    now += 1;
    const contentChanged = await getCachedAgentDiscovery(
      cwd,
      "user",
      cache,
      3000,
    );
    expect(contentChanged.agents.map((agent) => agent.name)).toEqual([
      "reviewer-new",
    ]);
    expect(contentChanged.ts).toBe(now);
    cache.delete(userKey);
    await rename(
      path.join(userDir, "reviewer.md"),
      path.join(userDir, "renamed.md"),
    );
    await writeFile(
      path.join(userDir, "renamed.md"),
      `---
name: renamed-reviewer
description: Renamed reviewer
---
Renamed prompt`,
    );
    now += 1;
    const listingChanged = await getCachedAgentDiscovery(
      cwd,
      "user",
      cache,
      3000,
    );
    expect(listingChanged.agents.map((agent) => agent.name)).toEqual([
      "renamed-reviewer",
    ]);
    expect(listingChanged.ts).toBe(now);
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache reset clears shared async completions", async () => {
  const root = await makeTempDir("pi-subagent-cache-reset-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  await mkdir(userDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(userDir, "first.md"),
    `---
name: first
description: First
---
First prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetAgentDiscoveryCache();
  const first = await getCachedAgentDiscovery(cwd, "user");
  expect(await getCachedAgentCompletions("second", cwd)).toEqual([]);
  await writeFile(
    path.join(userDir, "second.md"),
    `---
name: second
description: Second
---
Second prompt`,
  );
  expect(await getCachedAgentDiscovery(cwd, "user")).toBe(first);
  expect(await getCachedAgentCompletions("second", cwd)).toEqual([]);
  resetAgentDiscoveryCache();
  const second = await getCachedAgentDiscovery(cwd, "user");
  expect(second).not.toBe(first);
  expect(second.agents.some((agent) => agent.name === "second")).toBe(true);
  resetAgentDiscoveryCache();
  expect(await getCachedAgentCompletions("second", cwd)).toEqual([
    { value: "second", label: "second" },
  ]);
});

test("discoverAgents tolerates missing, invalid, and unreadable entries", async () => {
  const root = await makeTempDir("pi-subagent-discover-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-without-agents");
  expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
  const agentDirWithFile = path.join(root, "agent-with-file");
  await mkdir(agentDirWithFile, { recursive: true });
  await writeFile(path.join(agentDirWithFile, "agents"), "not a directory");
  process.env.PI_CODING_AGENT_DIR = agentDirWithFile;
  expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
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
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agents = discovery.agents;
  expect(agents).toHaveLength(1);
  expect(discovery.scopes.user.agents).toEqual(agents);
  expect(discovery.scopes.project).toEqual({ agents: [], markdownFiles: [] });
  expect([...discovery.scopes.user.markdownFiles].sort()).toEqual([
    "broken.md",
    "empty-options.md",
    "invalid-yaml.md",
    "missing-description.md",
    "non-object.md",
    "non-string-description.md",
    "non-string-name.md",
    "non-string-skills.md",
    "non-string-thinking.md",
    "non-string-tools.md",
  ]);
  expect(agents[0]).toMatchObject({
    name: "empty-options",
    tools: undefined,
    skills: [],
    thinking: undefined,
  });
});

test("repeated completion calls reuse cached both-scope discovery without redundant scans", async () => {
  const root = await makeTempDir("pi-subagent-scan-count-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  const projectDir = path.join(cwd, ".pi", "agents");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(userDir, "alpha.md"),
    `---
name: alpha
description: Alpha agent
---
Alpha prompt`,
  );
  await writeFile(
    path.join(projectDir, "beta.md"),
    `---
name: beta
description: Beta agent
---
Beta prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  const now = 10000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const result1 = await getCachedAgentCompletions("a", cwd, cache, 3000);
    const result2 = await getCachedAgentCompletions("a", cwd, cache, 3000);
    const result3 = await getCachedAgentCompletions("a", cwd, cache, 3000);
    expect(result1).toEqual([{ value: "alpha", label: "alpha" }]);
    expect(result2).toEqual(result1);
    expect(result3).toEqual(result1);
    expect(cache.size).toBe(3);
    const bothKey = `${path.resolve(cwd)}\0both`;
    const bothEntry = cache.get(bothKey);
    expect(bothEntry?.ts).toBe(10000);
  } finally {
    Date.now = originalNow;
  }
});

test("completion with different prefixes reuses same both-scope cache entry", async () => {
  const root = await makeTempDir("pi-subagent-multi-prefix-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  await mkdir(userDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(userDir, "alpha.md"),
    `---
name: alpha
description: Alpha
---
Alpha prompt`,
  );
  await writeFile(
    path.join(userDir, "beta.md"),
    `---
name: beta
description: Beta
---
Beta prompt`,
  );
  await writeFile(
    path.join(userDir, "gamma.md"),
    `---
name: gamma
description: Gamma
---
Gamma prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  const alphaResult = await getCachedAgentCompletions("a", cwd, cache);
  const betaResult = await getCachedAgentCompletions("b", cwd, cache);
  const gammaResult = await getCachedAgentCompletions("g", cwd, cache);
  const emptyResult = await getCachedAgentCompletions("x", cwd, cache);
  expect(alphaResult).toEqual([{ value: "alpha", label: "alpha" }]);
  expect(betaResult).toEqual([{ value: "beta", label: "beta" }]);
  expect(gammaResult).toEqual([{ value: "gamma", label: "gamma" }]);
  expect(emptyResult).toEqual([]);
  expect(cache.size).toBe(3);
});

test("scoped derivation from both reuses discovery with matching timestamps", async () => {
  const root = await makeTempDir("pi-subagent-derivation-ts-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  const projectDir = path.join(cwd, ".pi", "agents");
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
    path.join(projectDir, "same.md"),
    `---
name: same
description: Project same
---
Project prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  let now = 20000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    expect(cache.size).toBe(3);
    now += 100;
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    const project = await getCachedAgentDiscovery(cwd, "project", cache, 3000);
    expect(user.ts).toBe(both.ts);
    expect(project.ts).toBe(both.ts);
    expect(cache.size).toBe(3);
    expect(both.agents.find((a) => a.name === "same")?.source).toBe("project");
    expect(user.agents.find((a) => a.name === "same")?.source).toBe("user");
    expect(project.agents.find((a) => a.name === "same")?.source).toBe(
      "project",
    );
  } finally {
    Date.now = originalNow;
  }
});

test("same-name hidden user agent derivation supports collision detection", async () => {
  const root = await makeTempDir("pi-subagent-hidden-user-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  const projectDir = path.join(cwd, ".pi", "agents");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(userDir, "reviewer.md"),
    `---
name: reviewer
description: User reviewer
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
    path.join(projectDir, "reviewer.md"),
    `---
name: reviewer
description: Project reviewer
---
Project prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  const both = await getCachedAgentDiscovery(cwd, "both", cache);
  expect(both.agents.find((a) => a.name === "reviewer")?.source).toBe(
    "project",
  );
  expect(both.scopes.user.agents.some((a) => a.name === "reviewer")).toBe(true);
  const user = await getCachedAgentDiscovery(cwd, "user", cache);
  expect(user.agents.find((a) => a.name === "reviewer")?.source).toBe("user");
  expect(user.agents.find((a) => a.name === "reviewer")?.description).toBe(
    "User reviewer",
  );
  expect(user.agents.some((a) => a.name === "user-only")).toBe(true);
  expect(cache.size).toBe(3);
});

test("agent discovery cache handles unreadable directories gracefully", async () => {
  const root = await makeTempDir("pi-subagent-unreadable-dir-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  await mkdir(userDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(userDir, "valid.md"),
    `---
name: valid
description: Valid agent
---
Prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  await chmod(userDir, 0o000);
  try {
    const result = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(result.agents).toEqual([]);
    expect(result.scopes.user.agents).toEqual([]);
    expect(result.scopes.user.markdownFiles).toEqual([]);
  } finally {
    await chmod(userDir, 0o755);
  }
});

test("agent discovery cache handles unreadable files gracefully", async () => {
  const root = await makeTempDir("pi-subagent-unreadable-file-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  await mkdir(userDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const agentFile = path.join(userDir, "test.md");
  await writeFile(
    agentFile,
    `---
name: test
description: Test agent
---
Prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  await chmod(agentFile, 0o000);
  try {
    const result = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(result.agents).toEqual([]);
    expect(result.scopes.user.agents).toEqual([]);
    expect(result.scopes.user.markdownFiles).toEqual(["test.md"]);
  } finally {
    await chmod(agentFile, 0o644);
  }
});

test("agent discovery cache with exact TTL boundary", async () => {
  const root = await makeTempDir("pi-subagent-ttl-boundary-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  await mkdir(userDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(userDir, "test.md"),
    `---
name: test
description: Test
---
Prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  let now = 10000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const first = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(first.ts).toBe(10000);
    now = 13000;
    const exact = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(exact.ts).toBe(10000);
    now = 13001;
    const expired = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(expired.ts).toBe(13001);
  } finally {
    Date.now = originalNow;
  }
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
