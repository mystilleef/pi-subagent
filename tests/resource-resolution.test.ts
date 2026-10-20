import { describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  EXTENSION_DISCOVERY_CACHE_TTL_MS,
  resetResolvedAgentExtensionPathsCache,
  resetResolvedAgentSkillArgsCache,
  resolveAgentExtensionPaths,
  resolveAgentSkillArgs,
} from "../src/shared/utils.js";
import { makeTempDir, setupHooks } from "./helpers.js";

setupHooks();

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

test.each([
  {
    name: "resolveAgentExtensionPaths resolves npm scoped version-pinned package by terminal name",
    tempDirPrefix: "pi-subagent-ext-scoped-ver-",
    scopeDir: "@scope",
    packageDir: "helper",
    extensionPath: "npm:@scope/helper@1.2.3",
    sourcePath: "npm:@scope/helper@1.2.3",
    extensionName: "helper",
  },
  {
    name: "resolveAgentExtensionPaths resolves npm package names with dist/index.* via parent directory basename",
    tempDirPrefix: "pi-subagent-ext-dist-",
    scopeDir: "my-lib",
    packageDir: "dist",
    extensionPath: "npm:my-lib",
    sourcePath: "npm:my-lib",
    extensionName: "my-lib",
  },
])("$name", async (row) => {
  const root = await makeTempDir(row.tempDirPrefix);
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(
    root,
    "pkg",
    "node_modules",
    row.scopeDir,
    row.packageDir,
    "index.js",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: row.extensionPath,
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: row.sourcePath,
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
    const resolved = await resolveAgentExtensionPaths(cwd, [row.extensionName]);
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

test.each([
  {
    name: "resolveAgentExtensionPaths resolves project single-file .ts entry by file stem",
    tempDirPrefix: "pi-subagent-ext-single-ts-",
    fileName: "my-helper.ts",
    extensionPath: ".pi/extensions/my-helper.ts",
    source: ".pi/extensions/my-helper.ts",
    extensionName: "my-helper",
  },
  {
    name: "resolveAgentExtensionPaths preserves dotted stems in single-file short names",
    tempDirPrefix: "pi-subagent-ext-dotted-",
    fileName: "my.helper.tool.ts",
    extensionPath: ".pi/extensions/my.helper.tool.ts",
    source: ".pi/extensions/my.helper.tool.ts",
    extensionName: "my.helper.tool",
  },
  {
    name: "resolveAgentExtensionPaths resolves non-index file by file stem not parent directory",
    tempDirPrefix: "pi-subagent-ext-nonindex-",
    fileName: "custom.js",
    extensionPath: ".pi/extensions/custom.js",
    source: ".pi/extensions/custom.js",
    extensionName: "custom",
  },
])("$name", async (row) => {
  const root = await makeTempDir(row.tempDirPrefix);
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  const resolvedPath = path.join(cwd, ".pi", "extensions", row.fileName);
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async () => {};
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: row.extensionPath,
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: row.source,
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
    const resolved = await resolveAgentExtensionPaths(cwd, [row.extensionName]);
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

describe("utils.ts coverage gaps", () => {
  test("resolveAgentSkillArgs returns error for missing skills", async () => {
    const result = await resolveAgentSkillArgs("/tmp", ["nonexistent-skill"]);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Unknown skill");
      expect(result.error).toContain("nonexistent-skill");
    }
  });
});

describe("utils.ts coverage gaps", () => {
  test("resolveAgentSkillArgs returns empty args for empty skill list", async () => {
    const result = await resolveAgentSkillArgs("/tmp", []);
    expect(result).toEqual({ args: [] });
  });
});
