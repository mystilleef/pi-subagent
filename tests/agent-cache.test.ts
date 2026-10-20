import { expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDiscoveryCache } from "../src/agent/agent-cache.js";
import {
  AGENT_DISCOVERY_CACHE_TTL_MS,
  getCachedAgentCompletions,
  getCachedAgentDiscovery,
  resetAgentDiscoveryCache,
} from "../src/agent/agent-cache.js";
import { denyFsAccess, makeTempDir, setupHooks } from "./helpers.js";

setupHooks();

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
  const denied = denyFsAccess(userDir);
  try {
    const result = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(result.agents).toEqual([]);
    expect(result.scopes.user.agents).toEqual([]);
    expect(result.scopes.user.markdownFiles).toEqual([]);
  } finally {
    denied.restore();
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
  const denied = denyFsAccess(agentFile);
  try {
    const result = await getCachedAgentDiscovery(cwd, "user", cache, 3000);
    expect(result.agents).toEqual([]);
    expect(result.scopes.user.agents).toEqual([]);
    expect(result.scopes.user.markdownFiles).toEqual(["test.md"]);
  } finally {
    denied.restore();
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
