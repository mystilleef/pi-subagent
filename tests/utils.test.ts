import { expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
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
  DEFAULT_AGENT_END_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_OUTPUT_LINES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  detectMessageError,
  EXTENSION_DISCOVERY_CACHE_TTL_MS,
  getPiInvocation,
  getSubagentDepth,
  getSubagentOutputLimits,
  getSubagentRuntimeLimits,
  hasSubagentFailed,
  resetResolvedAgentExtensionPathsCache,
  resetResolvedAgentSkillArgsCache,
  resolveAgentExtensionPaths,
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

test("hasSubagentFailed is false when outcome is set, even with detectMessageError true", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "running..." }],
    },
    { role: "toolResult", content: [], isError: true },
  ] as unknown as Message[];
  expect(detectMessageError(messages)).toBe(true);
  expect(
    hasSubagentFailed({
      agent: "test",
      agentSource: "user",
      task: "task",
      exitCode: 0,
      stopReason: "toolUse",
      outcome: "Task complete.",
      messages,
      stderr: "",
      finalOutput: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    }),
  ).toBe(false);
});

test("hasSubagentFailed is false when outcome is set despite non-zero exitCode", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ] as unknown as Message[];
  expect(
    hasSubagentFailed({
      agent: "test",
      agentSource: "user",
      task: "task",
      exitCode: 1,
      stopReason: "stop",
      outcome: "Completed anyway.",
      messages,
      stderr: "",
      finalOutput: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    }),
  ).toBe(false);
});

test("detectMessageError is true when error follows the final assistant message", () => {
  expect(
    detectMessageError([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
      },
      { role: "toolResult", content: [], isError: true },
    ] as unknown as Message[]),
  ).toBe(true);
});

test("detectMessageError is false when text assistant message follows error and no subsequent error", () => {
  expect(
    detectMessageError([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
      },
      { role: "toolResult", content: [], isError: true },
      {
        role: "assistant",
        content: [{ type: "text", text: "Recovered." }],
      },
    ] as unknown as Message[]),
  ).toBe(false);
});

test("subagent runtime limits parse env values safely", () => {
  expect(DEFAULT_AGENT_END_GRACE_MS).toBe(250);
  expect(DEFAULT_MAX_STDERR_BYTES).toBe(10_000);
  expect(DEFAULT_MAX_SUBAGENT_DEPTH).toBe(3);
  expect(getSubagentRuntimeLimits()).toEqual({
    agentEndGraceMs: 250,
    maxStderrBytes: 10_000,
    maxDepth: 3,
  });
  expect(
    getSubagentRuntimeLimits({
      PI_SUBAGENT_AGENT_END_GRACE_MS: "125",
      PI_SUBAGENT_MAX_STDERR_BYTES: "2048",
      PI_SUBAGENT_MAX_DEPTH: "7",
    }),
  ).toEqual({ agentEndGraceMs: 125, maxStderrBytes: 2048, maxDepth: 7 });
  expect(
    getSubagentRuntimeLimits({
      PI_SUBAGENT_AGENT_END_GRACE_MS: 75,
      PI_SUBAGENT_MAX_STDERR_BYTES: 512,
      PI_SUBAGENT_MAX_DEPTH: 2,
    }),
  ).toEqual({ agentEndGraceMs: 75, maxStderrBytes: 512, maxDepth: 2 });
});

test("subagent runtime limits fall back for invalid env values", () => {
  const invalidValues = [
    undefined,
    "",
    "0",
    "-1",
    "1.5",
    "Infinity",
    "NaN",
    "not-a-number",
  ];
  for (const value of invalidValues) {
    expect(
      getSubagentRuntimeLimits({
        PI_SUBAGENT_AGENT_END_GRACE_MS: value,
        PI_SUBAGENT_MAX_STDERR_BYTES: value,
        PI_SUBAGENT_MAX_DEPTH: value,
      }),
    ).toEqual({ agentEndGraceMs: 250, maxStderrBytes: 10_000, maxDepth: 3 });
  }
});

test("subagent runtime max depth clamps above ceiling", () => {
  expect(getSubagentRuntimeLimits({ PI_SUBAGENT_MAX_DEPTH: "10" })).toEqual({
    agentEndGraceMs: 250,
    maxStderrBytes: 10_000,
    maxDepth: 10,
  });
  expect(getSubagentRuntimeLimits({ PI_SUBAGENT_MAX_DEPTH: "11" })).toEqual({
    agentEndGraceMs: 250,
    maxStderrBytes: 10_000,
    maxDepth: 10,
  });
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
    if (originalExecPath) {
      Object.defineProperty(process, "execPath", originalExecPath);
    } else {
      delete (process as unknown as { execPath?: string }).execPath;
    }
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

test("resolveAgentSkillArgs formats non-Error thrown values as error message", async () => {
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {
    throw "plain string failure";
  };
  try {
    await expect(
      resolveAgentSkillArgs(process.cwd(), ["helper"]),
    ).resolves.toEqual({
      error: "Failed to discover skills: plain string failure",
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

test("agent discovery cache primes scoped entries concurrently after cold both discovery", async () => {
  const root = await makeTempDir("pi-subagent-concurrent-prime-");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "work");
  const userDir = path.join(agentDir, "agents");
  const projectDir = path.join(cwd, ".pi", "agents");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(userDir, "user.md"),
    `---
name: user
description: User
---
User prompt`,
  );
  await writeFile(
    path.join(projectDir, "project.md"),
    `---
name: project
description: Project
---
Project prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  const originalReaddir = fsPromises.readdir;
  let listingReadCount = 0;
  let activePrimingReads = 0;
  let peakPrimingReads = 0;
  const readdirSpy = spyOn(fsPromises, "readdir").mockImplementation((async (
    ...args: Parameters<typeof fsPromises.readdir>
  ) => {
    if (args[0] === userDir || args[0] === projectDir) {
      listingReadCount += 1;
      if (listingReadCount > 4) {
        activePrimingReads += 1;
        peakPrimingReads = Math.max(peakPrimingReads, activePrimingReads);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activePrimingReads -= 1;
      }
    }
    return originalReaddir(...args);
  }) as typeof fsPromises.readdir);
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    const user = cache.get(`${path.resolve(cwd)}\0user`);
    const project = cache.get(`${path.resolve(cwd)}\0project`);
    expect(cache.size).toBe(3);
    expect(user?.agents.map((agent) => agent.name)).toEqual(["user"]);
    expect(project?.agents.map((agent) => agent.name)).toEqual(["project"]);
    expect(user?.ts).toBe(both.ts);
    expect(project?.ts).toBe(both.ts);
    expect(peakPrimingReads).toBe(2);
  } finally {
    readdirSpy.mockRestore();
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
    cache.delete(`${path.resolve(cwd)}\0user`);
    cache.delete(`${path.resolve(cwd)}\0project`);
    const readFileSpy = spyOn(fsPromises, "readFile").mockImplementation(
      (() => {
        throw new Error("derived cache must not hash markdown contents");
      }) as typeof fsPromises.readFile,
    );
    now += 1;
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    const project = await getCachedAgentDiscovery(cwd, "project", cache, 3000);
    readFileSpy.mockRestore();
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

test("agent discovery cache trusts successful empty derived listings", async () => {
  const root = await makeTempDir("pi-subagent-derived-empty-cache-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  const userKey = `${path.resolve(cwd)}\0user`;
  await mkdir(userDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  let now = 6000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    expect(both.snapshots?.user.listingTrusted).toBe(true);
    cache.delete(userKey);
    const readFileSpy = spyOn(fsPromises, "readFile").mockImplementation(
      (() => {
        throw new Error(
          "empty derived listing must not hash markdown contents",
        );
      }) as typeof fsPromises.readFile,
    );
    now += 1;
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    readFileSpy.mockRestore();
    expect(user.agents).toEqual([]);
    expect(user.scopes.user.markdownFiles).toEqual([]);
    expect(user.ts).toBe(both.ts);
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache falls back when fresh derived listing read fails", async () => {
  const root = await makeTempDir("pi-subagent-derived-listing-fail-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
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
  let now = 6500;
  const originalNow = Date.now;
  const originalReaddir = fsPromises.readdir;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    expect(both.snapshots?.user.listingTrusted).toBe(true);
    cache.delete(userKey);
    await writeFile(
      path.join(userDir, "reviewer.md"),
      `---
name: reviewer-new
description: Reviewer new
---
New prompt`,
    );
    let failingTrustRead = true;
    const freshReaddirSpy = spyOn(fsPromises, "readdir").mockImplementation(
      (async (...args: Parameters<typeof fsPromises.readdir>) => {
        if (args[0] === userDir && failingTrustRead) {
          failingTrustRead = false;
          throw new Error("simulated fresh listing failure");
        }
        return originalReaddir(...args);
      }) as typeof fsPromises.readdir,
    );
    now += 1;
    try {
      const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
      expect(user.agents.map((agent) => agent.name)).toEqual(["reviewer-new"]);
      expect(user.ts).toBe(now);
      expect(both.ts).toBe(6500);
    } finally {
      freshReaddirSpy.mockRestore();
    }
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache falls back when derived parent expires", async () => {
  const root = await makeTempDir("pi-subagent-derived-expired-cache-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
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
  let now = 6800;
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
    now += 3001;
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(user.agents.map((agent) => agent.name)).toEqual(["reviewer-new"]);
    expect(user.ts).toBe(now);
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache trusts fresh derived content and falls back on listing changes", async () => {
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
      "reviewer",
    ]);
    expect(contentChanged.ts).toBe(7000);
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

test("agent discovery cache falls back when derived snapshot metadata mismatches", async () => {
  const root = await makeTempDir("pi-subagent-derived-cache-metadata-");
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
  let now = 9000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    if (!both.snapshots) throw new Error("missing discovery snapshots");
    both.snapshots.user.markdownFiles = ["different.md"];
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
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(user.agents.map((agent) => agent.name)).toEqual(["reviewer-new"]);
    expect(user.ts).toBe(now);
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache falls back when derived snapshot listingTrusted is false", async () => {
  const root = await makeTempDir("pi-subagent-derived-trust-false-");
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
  let now = 9200;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    if (!both.snapshots) throw new Error("missing discovery snapshots");
    both.snapshots.user.listingTrusted = false;
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
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(user.agents.map((agent) => agent.name)).toEqual(["reviewer-new"]);
    expect(user.ts).toBe(now);
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache falls back when derived snapshot directory mismatches", async () => {
  const root = await makeTempDir("pi-subagent-derived-dir-mismatch-");
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
  let now = 9400;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    if (!both.snapshots) throw new Error("missing discovery snapshots");
    both.snapshots.user.directory = path.resolve("/other/agent/dir");
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
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(user.agents.map((agent) => agent.name)).toEqual(["reviewer-new"]);
    expect(user.ts).toBe(now);
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache falls back when empty derived listing trust read fails", async () => {
  const root = await makeTempDir("pi-subagent-derived-empty-fail-");
  const agentDir = path.join(root, "agent");
  const userDir = path.join(agentDir, "agents");
  const cwd = path.join(root, "work");
  const projectDir = path.join(cwd, ".pi", "agents");
  const userKey = `${path.resolve(cwd)}\0user`;
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cache: AgentDiscoveryCache = new Map();
  let now = 6700;
  const originalNow = Date.now;
  const originalReaddir = fsPromises.readdir;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    expect(both.agents).toEqual([]);
    expect(both.snapshots?.user.markdownFiles).toEqual([]);
    expect(both.snapshots?.user.listingTrusted).toBe(true);
    expect(both.snapshots?.project.markdownFiles).toEqual([]);
    expect(both.snapshots?.project.listingTrusted).toBe(true);
    cache.delete(userKey);
    let trustListingFailed = false;
    const readdirSpy = spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readdir>
    ) => {
      if (args[0] === userDir && !trustListingFailed) {
        trustListingFailed = true;
        throw new Error("simulated trust listing failure");
      }
      return originalReaddir(...args);
    }) as typeof fsPromises.readdir);
    now += 1;
    try {
      const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
      expect(user.agents).toEqual([]);
      expect(user.ts).toBe(now);
      expect(both.ts).toBe(6700);
      expect(user.ts).toBeGreaterThan(both.ts);
    } finally {
      readdirSpy.mockRestore();
    }
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache falls back when derived both entry has no snapshots", async () => {
  const root = await makeTempDir("pi-subagent-derived-no-snapshots-");
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
  let now = 9600;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    delete both.snapshots;
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
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(user.agents.map((agent) => agent.name)).toEqual(["reviewer-new"]);
    expect(user.ts).toBe(now);
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache falls back when snapshot listingTrusted is non-boolean", async () => {
  const root = await makeTempDir("pi-subagent-derived-trust-nonbool-");
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
  let now = 9800;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    // biome-ignore lint/suspicious/noExplicitAny: runtime type mutation for test
    (both.snapshots?.user as any).listingTrusted = "yes";
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
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(user.agents.map((agent) => agent.name)).toEqual(["reviewer-new"]);
    expect(user.ts).toBe(now);
  } finally {
    Date.now = originalNow;
  }
});

test("agent discovery cache falls back when snapshot directory is non-null non-string", async () => {
  const root = await makeTempDir("pi-subagent-derived-dir-nonstring-");
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
  let now = 9900;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const both = await getCachedAgentDiscovery(cwd, "both", cache, 3000);
    // biome-ignore lint/suspicious/noExplicitAny: runtime type mutation for test
    (both.snapshots?.user as any).directory = 42;
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
    const user = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(user.agents.map((agent) => agent.name)).toEqual(["reviewer-new"]);
    expect(user.ts).toBe(now);
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
  resetResolvedAgentSkillArgsCache();
});

test("resolveAgentSkillArgs caches successes by cwd and agent directory", async () => {
  const root = await makeTempDir("pi-subagent-skill-cache-");
  const cwdA = path.join(root, "work-a");
  const cwdB = path.join(root, "work-b");
  const agentDirA = path.join(root, "agent-a");
  const agentDirB = path.join(root, "agent-b");
  const cwdSkillA = path.join(cwdA, ".pi", "skills", "helper");
  const cwdSkillB = path.join(cwdB, ".pi", "skills", "helper");
  const agentSkillB = path.join(agentDirB, "skills", "helper");
  await mkdir(cwdSkillA, { recursive: true });
  await mkdir(cwdSkillB, { recursive: true });
  await mkdir(agentSkillB, { recursive: true });
  for (const dir of [cwdSkillA, cwdSkillB, agentSkillB]) {
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---
name: helper
description: Helps tests
---
# Helper
`,
    );
  }
  const originalReload = DefaultResourceLoader.prototype.reload;
  let reloads = 0;
  DefaultResourceLoader.prototype.reload = async function (...args) {
    reloads += 1;
    return originalReload.apply(this, args);
  };
  try {
    process.env.PI_CODING_AGENT_DIR = agentDirA;
    const first = await resolveAgentSkillArgs(cwdA, ["helper"]);
    const warm = await resolveAgentSkillArgs(cwdA, ["helper", "helper"]);
    process.env.PI_CODING_AGENT_DIR = agentDirB;
    const differentAgentDir = await resolveAgentSkillArgs(cwdA, ["helper"]);
    const differentCwd = await resolveAgentSkillArgs(cwdB, ["helper"]);
    expect(reloads).toBe(3);
    expect(first).toEqual({
      args: ["--skill", path.join(cwdSkillA, "SKILL.md")],
    });
    expect(warm).toEqual(first);
    expect(differentAgentDir).toEqual({
      args: ["--skill", path.join(cwdSkillA, "SKILL.md")],
    });
    expect(differentCwd).toEqual({
      args: ["--skill", path.join(cwdSkillB, "SKILL.md")],
    });
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentSkillArgsCache();
  }
});

test("resolveAgentSkillArgs preserves request order on order-insensitive warm hits", async () => {
  const root = await makeTempDir("pi-subagent-skill-order-");
  const cwd = path.join(root, "work");
  const alphaSkill = path.join(cwd, ".pi", "skills", "alpha");
  const betaSkill = path.join(cwd, ".pi", "skills", "beta");
  await mkdir(alphaSkill, { recursive: true });
  await mkdir(betaSkill, { recursive: true });
  await writeFile(
    path.join(alphaSkill, "SKILL.md"),
    `---
name: alpha
description: Alpha
---
# Alpha
`,
  );
  await writeFile(
    path.join(betaSkill, "SKILL.md"),
    `---
name: beta
description: Beta
---
# Beta
`,
  );
  const originalReload = DefaultResourceLoader.prototype.reload;
  let reloads = 0;
  DefaultResourceLoader.prototype.reload = async function (...args) {
    reloads += 1;
    return originalReload.apply(this, args);
  };
  try {
    const first = await resolveAgentSkillArgs(cwd, ["beta", "alpha"]);
    const warm = await resolveAgentSkillArgs(cwd, ["alpha", "beta", "alpha"]);
    expect(reloads).toBe(1);
    expect(first).toEqual({
      args: [
        "--skill",
        path.join(betaSkill, "SKILL.md"),
        "--skill",
        path.join(alphaSkill, "SKILL.md"),
      ],
    });
    expect(warm).toEqual({
      args: [
        "--skill",
        path.join(alphaSkill, "SKILL.md"),
        "--skill",
        path.join(betaSkill, "SKILL.md"),
      ],
    });
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentSkillArgsCache();
  }
});

test("resolveAgentSkillArgs keeps missing diagnostics in first-seen order", async () => {
  const root = await makeTempDir("pi-subagent-skill-missing-");
  const cwd = path.join(root, "work");
  const alphaSkill = path.join(cwd, ".pi", "skills", "alpha");
  const betaSkill = path.join(cwd, ".pi", "skills", "beta");
  await mkdir(alphaSkill, { recursive: true });
  await mkdir(betaSkill, { recursive: true });
  await writeFile(
    path.join(alphaSkill, "SKILL.md"),
    `---
name: alpha
description: Alpha
---
# Alpha
`,
  );
  await writeFile(
    path.join(betaSkill, "SKILL.md"),
    `---
name: beta
description: Beta
---
# Beta
`,
  );
  const resolved = await resolveAgentSkillArgs(cwd, [
    "zeta",
    "alpha",
    "eta",
    "zeta",
  ]);
  expect("error" in resolved).toBe(true);
  if ("error" in resolved) {
    expect(resolved.error).toStartWith(
      'Unknown skills: "zeta", "eta". Available skills:',
    );
    expect(resolved.error.indexOf("alpha")).toBeLessThan(
      resolved.error.indexOf("beta"),
    );
  }
  resetResolvedAgentSkillArgsCache();
});

test("resolveAgentSkillArgs isolates cache entries by active agent directory paths", async () => {
  const root = await makeTempDir("pi-subagent-skill-agent-dir-");
  const cwd = path.join(root, "work");
  const agentDirA = path.join(root, "agent-a");
  const agentDirB = path.join(root, "agent-b");
  const agentSkillA = path.join(agentDirA, "skills", "helper");
  const agentSkillB = path.join(agentDirB, "skills", "helper");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentSkillA, { recursive: true });
  await mkdir(agentSkillB, { recursive: true });
  for (const dir of [agentSkillA, agentSkillB]) {
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---
name: helper
description: Helps tests
---
# Helper
`,
    );
  }
  const originalReload = DefaultResourceLoader.prototype.reload;
  let reloads = 0;
  DefaultResourceLoader.prototype.reload = async function (...args) {
    reloads += 1;
    return originalReload.apply(this, args);
  };
  try {
    process.env.PI_CODING_AGENT_DIR = agentDirA;
    const first = await resolveAgentSkillArgs(cwd, ["helper"]);
    process.env.PI_CODING_AGENT_DIR = agentDirB;
    const second = await resolveAgentSkillArgs(cwd, ["helper"]);
    expect(reloads).toBe(2);
    expect(first).toEqual({
      args: ["--skill", path.join(agentSkillA, "SKILL.md")],
    });
    expect(second).toEqual({
      args: ["--skill", path.join(agentSkillB, "SKILL.md")],
    });
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentSkillArgsCache();
  }
});

test("resolveAgentSkillArgs canonicalizes cwd via realpath with resolve fallback on error", async () => {
  const root = await makeTempDir("pi-subagent-skill-canonical-");
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
  const originalRealpath = fsPromises.realpath;
  let realpathCalls = 0;
  const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation((async (
    filePath: string,
  ) => {
    realpathCalls += 1;
    if (realpathCalls <= 2) throw new Error("ENOENT");
    return originalRealpath(filePath);
  }) as typeof fsPromises.realpath);
  try {
    const resolved = await resolveAgentSkillArgs(cwd, ["helper"]);
    expect(resolved).toEqual({
      args: ["--skill", path.join(skillDir, "SKILL.md")],
    });
  } finally {
    realpathSpy.mockRestore();
    resetResolvedAgentSkillArgsCache();
  }
});

test("resolveAgentSkillArgs expires warm cache entries after discovery TTL", async () => {
  const root = await makeTempDir("pi-subagent-skill-cache-ttl-");
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
  const originalNow = Date.now;
  const originalReload = DefaultResourceLoader.prototype.reload;
  let now = 1000;
  let reloads = 0;
  Date.now = () => now;
  DefaultResourceLoader.prototype.reload = async function (...args) {
    reloads += 1;
    return originalReload.apply(this, args);
  };
  try {
    await resolveAgentSkillArgs(cwd, ["helper"]);
    now += 300000;
    await resolveAgentSkillArgs(cwd, ["helper"]);
    now += 1;
    await resolveAgentSkillArgs(cwd, ["helper"]);
    expect(reloads).toBe(2);
  } finally {
    Date.now = originalNow;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentSkillArgsCache();
  }
});

test("resolveAgentSkillArgs falls back to absolute path when realpath fails", async () => {
  const root = await makeTempDir("pi-subagent-realpath-fallback-");
  const cwd = path.join(root, "work");
  const skillDir = path.join(cwd, ".pi", "skills", "helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: helper
description: Helper
---
# Helper
`,
  );
  const originalRealpath = fsPromises.realpath;
  const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation((async (
    p: string,
  ) => {
    if (p === cwd) throw new Error("broken symlink");
    return originalRealpath(p);
  }) as typeof fsPromises.realpath);
  try {
    const resolved = await resolveAgentSkillArgs(cwd, ["helper"]);
    expect("args" in resolved).toBe(true);
    if ("args" in resolved) {
      expect(resolved.args).toEqual([
        "--skill",
        path.join(skillDir, "SKILL.md"),
      ]);
    }
  } finally {
    realpathSpy.mockRestore();
    resetResolvedAgentSkillArgsCache();
  }
});

test("resolveAgentExtensionPaths short-circuits empty requested names", async () => {
  const originalReload = DefaultResourceLoader.prototype.reload;
  let reloadCalls = 0;
  DefaultResourceLoader.prototype.reload = async () => {
    reloadCalls += 1;
  };
  try {
    const resolved = await resolveAgentExtensionPaths(process.cwd(), []);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([]);
    }
    expect(reloadCalls).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves npm short names to resolved paths", async () => {
  const root = await makeTempDir("pi-subagent-ext-npm-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath1 = path.join(
    root,
    "pkg",
    "node_modules",
    "context-mode",
    "dist",
    "index.js",
  );
  const resolvedPath2 = path.join(
    root,
    "pkg",
    "node_modules",
    "helper",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:context-mode",
        resolvedPath: resolvedPath1,
        sourceInfo: {
          path: resolvedPath1,
          source: "npm:context-mode",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
      {
        path: "npm:@scope/helper",
        resolvedPath: resolvedPath2,
        sourceInfo: {
          path: resolvedPath2,
          source: "npm:@scope/helper",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, [
      "context-mode",
      "helper",
    ]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath1, resolvedPath2]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves project path short names to resolved paths", async () => {
  const root = await makeTempDir("pi-subagent-ext-project-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    cwd,
    ".pi",
    "extensions",
    "my-ext",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/my-ext",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/my-ext",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["my-ext"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves absolute path short names to resolved paths", async () => {
  const root = await makeTempDir("pi-subagent-ext-absolute-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(root, "custom-ext", "index.js");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: resolvedPath,
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: resolvedPath,
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["custom-ext"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths deduplicates requested names by first occurrence", async () => {
  const root = await makeTempDir("pi-subagent-ext-dedup-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    "helper",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:helper",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:helper",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, [
      "helper",
      "helper",
      "helper",
    ]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths returns error when no extensions installed", async () => {
  const root = await makeTempDir("pi-subagent-ext-none-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["helper"]);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toContain('Unknown extension: "helper"');
      expect(resolved.error).toContain("Available extensions: none");
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths returns error on thrown reload", async () => {
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {
    throw new Error("scan failed");
  };
  try {
    const resolved = await resolveAgentExtensionPaths(process.cwd(), [
      "helper",
    ]);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toBe("Failed to discover extensions: scan failed");
    }
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths formats non-Error thrown values as error message", async () => {
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {
    throw "plain string reload failure";
  };
  try {
    const resolved = await resolveAgentExtensionPaths(process.cwd(), [
      "helper",
    ]);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toBe(
        "Failed to discover extensions: plain string reload failure",
      );
    }
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths returns error on getExtensions errors", async () => {
  const root = await makeTempDir("pi-subagent-ext-errs-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [],
    errors: [
      { path: "/bad/ext", error: "cannot load module" },
      { path: "/other/ext", error: "syntax error" },
    ],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["helper"]);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toContain("Failed to discover extensions");
      expect(resolved.error).toContain("/bad/ext");
      expect(resolved.error).toContain("cannot load module");
      expect(resolved.error).toContain("/other/ext");
      expect(resolved.error).toContain("syntax error");
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths caches by cwd and agent directory", async () => {
  const root = await makeTempDir("pi-subagent-ext-cache-");
  const cwdA = path.join(root, "work-a");
  const cwdB = path.join(root, "work-b");
  await mkdir(cwdA, { recursive: true });
  await mkdir(cwdB, { recursive: true });
  const resolvedPathA = path.join(
    root,
    "pkg-a",
    "node_modules",
    "helper",
    "index.js",
  );
  const resolvedPathB = path.join(
    root,
    "pkg-b",
    "node_modules",
    "helper",
    "index.js",
  );
  let reloadCalls = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {
    reloadCalls += 1;
  };
  let getExtensionsCalls = 0;
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => {
    getExtensionsCalls += 1;
    const rp = getExtensionsCalls <= 1 ? resolvedPathA : resolvedPathB;
    return {
      extensions: [
        {
          path: "npm:helper",
          resolvedPath: rp,
          sourceInfo: {
            path: rp,
            source: "npm:helper",
            scope: "user",
            origin: "package" as const,
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
      ],
      errors: [],
      runtime: {} as never,
    };
  };
  try {
    const first = await resolveAgentExtensionPaths(cwdA, ["helper"]);
    const warm = await resolveAgentExtensionPaths(cwdA, ["helper"]);
    const differentCwd = await resolveAgentExtensionPaths(cwdB, ["helper"]);
    expect(reloadCalls).toBeGreaterThanOrEqual(2);
    expect("resolvedPaths" in first).toBe(true);
    if ("resolvedPaths" in first)
      expect(first.resolvedPaths).toEqual([resolvedPathA]);
    if ("resolvedPaths" in warm)
      expect(warm.resolvedPaths).toEqual([resolvedPathA]);
    expect("resolvedPaths" in differentCwd).toBe(true);
    if ("resolvedPaths" in differentCwd)
      expect(differentCwd.resolvedPaths).toEqual([resolvedPathB]);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths expires cache after TTL", async () => {
  const root = await makeTempDir("pi-subagent-ext-ttl-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    "helper",
    "index.js",
  );
  let reloadCalls = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {
    reloadCalls += 1;
  };
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:helper",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:helper",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    await resolveAgentExtensionPaths(cwd, ["helper"]);
    now += EXTENSION_DISCOVERY_CACHE_TTL_MS;
    await resolveAgentExtensionPaths(cwd, ["helper"]);
    now += 1;
    await resolveAgentExtensionPaths(cwd, ["helper"]);
    expect(reloadCalls).toBe(2);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    Date.now = originalNow;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths preserves request order on warm cache hits", async () => {
  const root = await makeTempDir("pi-subagent-ext-order-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedAlpha = path.join(
    root,
    "pkg",
    "node_modules",
    "alpha",
    "index.js",
  );
  const resolvedBeta = path.join(
    root,
    "pkg",
    "node_modules",
    "beta",
    "index.js",
  );
  let reloadCalls = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {
    reloadCalls += 1;
  };
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:alpha",
        resolvedPath: resolvedAlpha,
        sourceInfo: {
          path: resolvedAlpha,
          source: "npm:alpha",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
      {
        path: "npm:beta",
        resolvedPath: resolvedBeta,
        sourceInfo: {
          path: resolvedBeta,
          source: "npm:beta",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const first = await resolveAgentExtensionPaths(cwd, ["beta", "alpha"]);
    const warm = await resolveAgentExtensionPaths(cwd, [
      "alpha",
      "beta",
      "alpha",
    ]);
    expect(reloadCalls).toBe(1);
    expect("resolvedPaths" in first).toBe(true);
    if ("resolvedPaths" in first)
      expect(first.resolvedPaths).toEqual([resolvedBeta, resolvedAlpha]);
    expect("resolvedPaths" in warm).toBe(true);
    if ("resolvedPaths" in warm)
      expect(warm.resolvedPaths).toEqual([resolvedAlpha, resolvedBeta]);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths reports missing names in first-seen order with sorted available", async () => {
  const root = await makeTempDir("pi-subagent-ext-missing-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedAlpha = path.join(
    root,
    "pkg",
    "node_modules",
    "alpha",
    "index.js",
  );
  const resolvedBeta = path.join(
    root,
    "pkg",
    "node_modules",
    "beta",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:alpha",
        resolvedPath: resolvedAlpha,
        sourceInfo: {
          path: resolvedAlpha,
          source: "npm:alpha",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
      {
        path: "npm:beta",
        resolvedPath: resolvedBeta,
        sourceInfo: {
          path: resolvedBeta,
          source: "npm:beta",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, [
      "zeta",
      "alpha",
      "eta",
      "zeta",
    ]);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toStartWith('Unknown extensions: "zeta", "eta".');
      expect(resolved.error).toContain("Available extensions:");
      expect(resolved.error.indexOf("alpha")).toBeLessThan(
        resolved.error.indexOf("beta"),
      );
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves npm unscoped version-pinned package by terminal name", async () => {
  const root = await makeTempDir("pi-subagent-ext-npm-ver-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    "helper",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:helper@1.2.3",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:helper@1.2.3",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["helper"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves npm scoped version-pinned package by terminal name", async () => {
  const root = await makeTempDir("pi-subagent-ext-scoped-ver-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    "@scope",
    "helper",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:@scope/helper@1.2.3",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:@scope/helper@1.2.3",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["helper"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths reports unknown extension for versioned requested name", async () => {
  const root = await makeTempDir("pi-subagent-ext-ver-unknown-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    "helper",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:helper@2.0.0",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:helper@2.0.0",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["helper@2.0.0"]);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toStartWith('Unknown extension: "helper@2.0.0".');
      expect(resolved.error).toContain("Available extensions: helper.");
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves file: local path with at-sign in path by path-derived name", async () => {
  const root = await makeTempDir("pi-subagent-ext-file-at-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(root, "@my-ext", "index.js");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: `file:${root}/@my-ext`,
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: `file:${root}/@my-ext`,
          scope: "project",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["@my-ext"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths canonicalizes cwd via realpath with resolve fallback", async () => {
  const root = await makeTempDir("pi-subagent-ext-canonical-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    "helper",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:helper",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:helper",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  const originalRealpath = fsPromises.realpath;
  let realpathCalls = 0;
  const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation((async (
    filePath: string,
  ) => {
    realpathCalls += 1;
    if (realpathCalls <= 2) throw new Error("ENOENT");
    return originalRealpath(filePath);
  }) as typeof fsPromises.realpath);
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["helper"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    realpathSpy.mockRestore();
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths falls back to absolute path when realpath fails", async () => {
  const root = await makeTempDir("pi-subagent-ext-realpath-fail-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    "helper",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:helper",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:helper",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  const originalRealpath = fsPromises.realpath;
  const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation((async (
    p: string,
  ) => {
    if (p === cwd) throw new Error("broken symlink");
    return originalRealpath(p);
  }) as typeof fsPromises.realpath);
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["helper"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    realpathSpy.mockRestore();
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves nested src/index.* short names to root basename", async () => {
  const root = await makeTempDir("pi-subagent-ext-src-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    cwd,
    ".pi",
    "extensions",
    "my-ext",
    "src",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/my-ext",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/my-ext",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["my-ext"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves home-relative short names to resolved paths", async () => {
  const root = await makeTempDir("pi-subagent-ext-home-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const agentDir = path.join(root, "agent");
  const extDir = path.join(agentDir, "extensions");
  const resolvedPath = path.join(extDir, "my-ext", "index.js");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: path.join(extDir, "my-ext"),
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: path.join(extDir, "my-ext"),
          scope: "user",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["my-ext"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves package-source local path short names to resolved paths", async () => {
  const root = await makeTempDir("pi-subagent-ext-local-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(root, "my-ext", "index.js");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: `file:${root}/my-ext`,
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: `file:${root}/my-ext`,
          scope: "project",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["my-ext"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves npm package names with dist/index.* via parent directory basename", async () => {
  const root = await makeTempDir("pi-subagent-ext-dist-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    "my-lib",
    "dist",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:my-lib",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:my-lib",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["my-lib"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves npm scoped package with dist/index.* via parent directory basename", async () => {
  const root = await makeTempDir("pi-subagent-ext-scoped-dist-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    "@scope",
    "my-lib",
    "dist",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:@scope/my-lib",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:@scope/my-lib",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["my-lib"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves project single-file .ts entry by file stem", async () => {
  const root = await makeTempDir("pi-subagent-ext-single-ts-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(cwd, ".pi", "extensions", "my-helper.ts");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/my-helper.ts",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/my-helper.ts",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["my-helper"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves user single-file .js entry by file stem", async () => {
  const root = await makeTempDir("pi-subagent-ext-single-js-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const agentDir = path.join(root, "agent");
  const extDir = path.join(agentDir, "extensions");
  const resolvedPath = path.join(extDir, "my-tool.js");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: path.join(extDir, "my-tool.js"),
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: path.join(extDir, "my-tool.js"),
          scope: "user",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["my-tool"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths preserves dotted stems in single-file short names", async () => {
  const root = await makeTempDir("pi-subagent-ext-dotted-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(cwd, ".pi", "extensions", "my.helper.tool.ts");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/my.helper.tool.ts",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/my.helper.tool.ts",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["my.helper.tool"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths resolves non-index file by file stem not parent directory", async () => {
  const root = await makeTempDir("pi-subagent-ext-nonindex-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(cwd, ".pi", "extensions", "custom.js");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/custom.js",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/custom.js",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["custom"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedPath]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths selects first-discovered path when version-pinned and non-pinned npm packages share terminal name", async () => {
  const root = await makeTempDir("pi-subagent-ext-dup-ver-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedFirst = path.join(
    root,
    "pkg-a",
    "node_modules",
    "helper",
    "index.js",
  );
  const resolvedSecond = path.join(
    root,
    "pkg-b",
    "node_modules",
    "helper",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:helper@1.2.3",
        resolvedPath: resolvedFirst,
        sourceInfo: {
          path: resolvedFirst,
          source: "npm:helper@1.2.3",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
      {
        path: "npm:helper",
        resolvedPath: resolvedSecond,
        sourceInfo: {
          path: resolvedSecond,
          source: "npm:helper",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["helper"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedFirst]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths selects first-discovered path when single-file and directory extension share file stem", async () => {
  const root = await makeTempDir("pi-subagent-ext-dup-file-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedFirst = path.join(cwd, ".pi", "extensions", "tool.ts");
  const resolvedSecond = path.join(
    cwd,
    ".pi",
    "extensions",
    "tool",
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/tool.ts",
        resolvedPath: resolvedFirst,
        sourceInfo: {
          path: resolvedFirst,
          source: ".pi/extensions/tool.ts",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
      {
        path: ".pi/extensions/tool",
        resolvedPath: resolvedSecond,
        sourceInfo: {
          path: resolvedSecond,
          source: ".pi/extensions/tool",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, ["tool"]);
    expect("resolvedPaths" in resolved).toBe(true);
    if ("resolvedPaths" in resolved) {
      expect(resolved.resolvedPaths).toEqual([resolvedFirst]);
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths reports missing names in first-seen order when available extensions include single-file entries", async () => {
  const root = await makeTempDir("pi-subagent-ext-miss-single-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedA = path.join(cwd, ".pi", "extensions", "alpha.ts");
  const resolvedB = path.join(cwd, ".pi", "extensions", "beta", "index.js");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/alpha.ts",
        resolvedPath: resolvedA,
        sourceInfo: {
          path: resolvedA,
          source: ".pi/extensions/alpha.ts",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
      {
        path: ".pi/extensions/beta",
        resolvedPath: resolvedB,
        sourceInfo: {
          path: resolvedB,
          source: ".pi/extensions/beta",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, [
      "zeta",
      "alpha",
      "eta",
      "zeta",
    ]);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toStartWith('Unknown extensions: "zeta", "eta".');
      expect(resolved.error).toContain("Available extensions:");
      expect(resolved.error.indexOf("alpha")).toBeLessThan(
        resolved.error.indexOf("beta"),
      );
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths reports missing names in first-seen order when available extensions include version-pinned npm entries", async () => {
  const root = await makeTempDir("pi-subagent-ext-miss-ver-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedA = path.join(root, "pkg", "node_modules", "alpha", "index.js");
  const resolvedB = path.join(root, "pkg", "node_modules", "beta", "index.js");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "npm:alpha@4.0.0",
        resolvedPath: resolvedA,
        sourceInfo: {
          path: resolvedA,
          source: "npm:alpha@4.0.0",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
      {
        path: "npm:beta@1.0.0",
        resolvedPath: resolvedB,
        sourceInfo: {
          path: resolvedB,
          source: "npm:beta@1.0.0",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const resolved = await resolveAgentExtensionPaths(cwd, [
      "zeta",
      "alpha",
      "eta",
      "zeta",
    ]);
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toStartWith('Unknown extensions: "zeta", "eta".');
      expect(resolved.error).toContain("Available extensions:");
      expect(resolved.error.indexOf("alpha")).toBeLessThan(
        resolved.error.indexOf("beta"),
      );
    }
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
    resetResolvedAgentExtensionPathsCache();
  }
});

test("resolveAgentExtensionPaths preserves request order with mixed single-file and version-pinned npm extensions", async () => {
  const root = await makeTempDir("pi-subagent-ext-order-mix-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedFile = path.join(cwd, ".pi", "extensions", "local-tool.ts");
  const resolvedNpm = path.join(
    root,
    "pkg",
    "node_modules",
    "npm-tool",
    "index.js",
  );
  const resolvedVer = path.join(
    root,
    "pkg",
    "node_modules",
    "ver-tool",
    "index.js",
  );
  let reloadCalls = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {
    reloadCalls += 1;
  };
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/local-tool.ts",
        resolvedPath: resolvedFile,
        sourceInfo: {
          path: resolvedFile,
          source: ".pi/extensions/local-tool.ts",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
      {
        path: "npm:npm-tool",
        resolvedPath: resolvedNpm,
        sourceInfo: {
          path: resolvedNpm,
          source: "npm:npm-tool",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
      {
        path: "npm:ver-tool@3.0.0",
        resolvedPath: resolvedVer,
        sourceInfo: {
          path: resolvedVer,
          source: "npm:ver-tool@3.0.0",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  try {
    const first = await resolveAgentExtensionPaths(cwd, [
      "npm-tool",
      "local-tool",
      "ver-tool",
    ]);
    const warm = await resolveAgentExtensionPaths(cwd, [
      "ver-tool",
      "npm-tool",
      "local-tool",
    ]);
    expect(reloadCalls).toBe(1);
    expect("resolvedPaths" in first).toBe(true);
    if ("resolvedPaths" in first)
      expect(first.resolvedPaths).toEqual([
        resolvedNpm,
        resolvedFile,
        resolvedVer,
      ]);
    expect("resolvedPaths" in warm).toBe(true);
    if ("resolvedPaths" in warm)
      expect(warm.resolvedPaths).toEqual([
        resolvedVer,
        resolvedNpm,
        resolvedFile,
      ]);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    resetResolvedAgentExtensionPathsCache();
  }
});
