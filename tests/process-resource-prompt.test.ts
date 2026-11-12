import { expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agent/agents.js";
import { runSingleAgent } from "../src/child/process.js";
import {
  resetResolvedAgentExtensionPathsCache,
  resetResolvedAgentSkillArgsCache,
  resolveAgentSkillArgs,
} from "../src/shared/resource-resolution.js";
import type { SingleResult } from "../src/shared/types.js";
import {
  hangAgent,
  installFakePi,
  makeSubagentDetails,
  setupHooks,
  setupTest,
  withMkdtempCapture,
} from "./helpers.js";

setupHooks();

test("runSingleAgent starts skill resolution and prompt setup concurrently", async () => {
  const { cwd, agentDir } = await setupTest();
  const skillDir = path.join(agentDir, "skills", "fast");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: fast
description: Fast skill
---
Use fast skill.
`,
  );
  const originalReload = DefaultResourceLoader.prototype.reload;
  const originalWriteFile = fs.promises.writeFile;
  let releaseReload = () => {};
  const reloadStarted = Promise.withResolvers<void>();
  const writeStarted = Promise.withResolvers<void>();
  let released = false;
  const reloadRelease = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  DefaultResourceLoader.prototype.reload = async function delayedReload() {
    reloadStarted.resolve();
    await reloadRelease;
    return originalReload.call(this);
  };
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async (...args: unknown[]) => {
      writeStarted.resolve();
      return Reflect.apply(originalWriteFile, fs.promises, args);
    },
  });
  const agent: AgentConfig = {
    name: "concurrent",
    description: "Concurrent agent",
    thinking: "off",
    systemPrompt: "Concurrent prompt.",
    source: "user",
    filePath: "concurrent.md",
    skills: ["fast"],
  };
  const promise = runSingleAgent(
    cwd,
    [agent],
    "concurrent",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseReload();
  };
  try {
    await reloadStarted.promise;
    await writeStarted.promise;
    releaseOnce();
    const outcome = await promise;
    expect(outcome.kind).toBe("completed");
    expect(outcome.result.exitCode).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    releaseOnce();
    await promise.catch(() => {});
  }
});

test("runSingleAgent uses warmed skill cache without blocking prompt setup", async () => {
  const { cwd, agentDir } = await setupTest();
  const skillDir = path.join(agentDir, "skills", "warm");
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    skillPath,
    `---
name: warm
description: Warm skill
---
Use warm skill.
`,
  );
  resetResolvedAgentSkillArgsCache();
  expect(await resolveAgentSkillArgs(cwd, ["warm"])).toEqual({
    args: ["--skill", skillPath],
  });
  const originalReload = DefaultResourceLoader.prototype.reload;
  const originalWriteFile = fs.promises.writeFile;
  let reloadCalled = false;
  let promptWriteStarted = false;
  DefaultResourceLoader.prototype.reload = async function failWarmReload() {
    reloadCalled = true;
    throw new Error("warm cache missed");
  };
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async (...args: unknown[]) => {
      if (String(args[1]).includes("Warm prompt.")) promptWriteStarted = true;
      return Reflect.apply(originalWriteFile, fs.promises, args);
    },
  });
  const agent: AgentConfig = {
    name: "warm-agent",
    description: "Warm agent",
    thinking: "off",
    systemPrompt: "Warm prompt.",
    source: "user",
    filePath: "warm-agent.md",
    skills: ["warm"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "warm-agent",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(reloadCalled).toBe(false);
    expect(promptWriteStarted).toBe(true);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    resetResolvedAgentSkillArgsCache();
  }
});

test.each<{
  resolver: string;
  fields: Partial<AgentConfig>;
  error: string;
}>([
  {
    resolver: "skill",
    fields: { skills: ["missing-skill"] },
    error: 'Unknown skill: "missing-skill"',
  },
  {
    resolver: "replace_prompt skill",
    fields: { skills: ["missing-skill"], replacePrompt: true },
    error: 'Unknown skill: "missing-skill"',
  },
  {
    resolver: "extension",
    fields: { extensions: ["missing-ext"] },
    error: 'Unknown extension: "missing-ext"',
  },
])(
  "runSingleAgent cleans prompt temp file when $resolver resolution fails after prompt creation",
  async ({ fields, error }) => {
    const { cwd } = await setupTest();
    const agent: AgentConfig = {
      name: "bad-resource",
      description: "Bad resource",
      thinking: "off",
      systemPrompt: "Prompt that creates a temp file.",
      source: "user",
      filePath: "bad-resource.md",
      ...fields,
    };
    const { result, tmpDir } = await withMkdtempCapture(async (getTmpDir) => {
      const { result } = await runSingleAgent(
        cwd,
        [agent],
        agent.name,
        "task",
        undefined,
        undefined,
        makeSubagentDetails,
        undefined,
        "off",
      );
      return { result, tmpDir: getTmpDir() };
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(error);
    if (!tmpDir) throw new Error("prompt temp dir was never created");
    expect(fs.existsSync(tmpDir)).toBe(false);
  },
);

test("runSingleAgent returns skill error when both skill and extension resolution fail", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    name: "dual-fail",
    description: "Dual failure",
    thinking: "off",
    systemPrompt: "Prompt.",
    source: "user",
    filePath: "dual-fail.md",
    skills: ["missing-skill"],
    extensions: ["missing-ext"],
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    "dual-fail",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown skill: "missing-skill"');
  expect(result.stderr).not.toContain('"missing-ext"');
});

test("runSingleAgent returns completed error when prompt setup fails", async () => {
  const { cwd } = await setupTest();
  const originalWriteFile = fs.promises.writeFile;
  const writeError = new Error("ENOSPC: no space left on device");
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async (...args: unknown[]) => {
      const content = args[1];
      if (
        typeof content === "string" &&
        content.includes("Prompt setup fail.")
      ) {
        throw writeError;
      }
      return Reflect.apply(originalWriteFile, fs.promises, args);
    },
  });
  const agent: AgentConfig = {
    name: "prompt-fail",
    description: "Prompt failure",
    thinking: "off",
    systemPrompt: "Prompt setup fail.",
    source: "user",
    filePath: "prompt-fail.md",
  };
  let leakedPromptDir: string | undefined;
  try {
    const outcome = await withMkdtempCapture(async (getTmpDir) => {
      const runResult = await runSingleAgent(
        cwd,
        [agent],
        "prompt-fail",
        "task",
        undefined,
        undefined,
        makeSubagentDetails,
        undefined,
        "off",
      );
      leakedPromptDir = getTmpDir();
      return runResult;
    });
    expect(outcome.kind).toBe("completed");
    expect(outcome.result.exitCode).toBe(1);
    expect(outcome.result.stderr).toContain("Failed to write prompt");
    expect(outcome.result.stderr).toContain("ENOSPC");
  } finally {
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    if (leakedPromptDir) {
      await fs.promises.rm(leakedPromptDir, { recursive: true, force: true });
    }
  }
});

test("runSingleAgent disabled-without-names skips loader discovery for extensions", async () => {
  let reloadCalls = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async function trackReload() {
    reloadCalls += 1;
    return originalReload.call(this);
  };
  const { cwd } = await setupTest();
  try {
    const agent: AgentConfig = {
      ...hangAgent,
      extensions: [],
    };
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    expect(reloadCalls).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("runSingleAgent omitted extensions skips loader discovery for extensions", async () => {
  let reloadCalls = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async function trackReload() {
    reloadCalls += 1;
    return originalReload.call(this);
  };
  const { cwd } = await setupTest();
  try {
    const agent: AgentConfig = { ...hangAgent };
    expect(Object.hasOwn(agent, "extensions")).toBe(false);
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    expect(reloadCalls).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("runSingleAgent unknown extension names return error result before child spawn", async () => {
  const { cwd, binDir } = await setupTest();
  await installFakePi(
    binDir,
    `#!/bin/sh
echo "should not run" > spawn-marker.txt
exit 0
`,
  );
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["nonexistent-ext"],
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown extension: "nonexistent-ext"');
  expect(result.stderr).toContain("Available extensions:");
  expect(fs.existsSync(path.join(cwd, "spawn-marker.txt"))).toBe(false);
});

test("runSingleAgent loader reload failure returns error result before child spawn", async () => {
  const { cwd, binDir } = await setupTest();
  await installFakePi(
    binDir,
    `#!/bin/sh
echo "should not run" > spawn-marker.txt
exit 0
`,
  );
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async function failReload() {
    throw new Error("loader crashed");
  };
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["some-ext"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to discover extensions");
    expect(result.stderr).toContain("loader crashed");
    expect(fs.existsSync(path.join(cwd, "spawn-marker.txt"))).toBe(false);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("runSingleAgent getExtensions errors return actionable diagnostics before child spawn", async () => {
  const { cwd, binDir } = await setupTest();
  await installFakePi(
    binDir,
    `#!/bin/sh
echo "should not run" > spawn-marker.txt
exit 0
`,
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions =
    function errorGetExtensions() {
      return {
        extensions: [],
        errors: [
          { path: "/broken/ext", error: "ENOENT" },
          { path: "/bad/ext", error: "EACCES" },
        ],
        runtime: {} as never,
      };
    };
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["some-ext"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to discover extensions");
    expect(result.stderr).toContain("/broken/ext: ENOENT");
    expect(result.stderr).toContain("/bad/ext: EACCES");
    expect(fs.existsSync(path.join(cwd, "spawn-marker.txt"))).toBe(false);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent cleans prompt temp file after extension resolution failure", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    ...hangAgent,
    name: "badext",
    systemPrompt: "Prompt that creates a temp file.",
    extensions: ["nonexistent-ext"],
  };
  let _result: SingleResult | undefined;
  const getTmpDir = await withMkdtempCapture(async (getTmpDir) => {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "badext",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    _result = result;
    return getTmpDir;
  });
  if (!_result) throw new Error("result missing");
  expect(_result.exitCode).toBe(1);
  expect(_result.stderr).toContain('Unknown extension: "nonexistent-ext"');
  const tmpDir = getTmpDir();
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

test("runSingleAgent skill failure takes precedence over concurrent extension failure", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    ...hangAgent,
    skills: ["missing-skill"],
    extensions: ["nonexistent-ext"],
    systemPrompt: "Prompt.",
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown skill: "missing-skill"');
  expect(result.stderr).not.toContain("extension");
});

test("runSingleAgent starts skill resolution, extension resolution, and prompt setup concurrently", async () => {
  const { cwd, agentDir } = await setupTest();
  const skillDir = path.join(agentDir, "skills", "conext");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: conext
description: Concurrent extension skill
---
Use conext skill.
`,
  );
  const extDir = path.join(agentDir, "extensions");
  await fs.promises.mkdir(extDir, { recursive: true });
  const extResolvedPath = path.join(extDir, "conext", "index.js");
  await fs.promises.mkdir(path.dirname(extResolvedPath), { recursive: true });
  await fs.promises.writeFile(
    extResolvedPath,
    "module.exports = function() {}",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: "extensions/conext",
          resolvedPath: extResolvedPath,
          sourceInfo: {
            path: extResolvedPath,
            source: "extensions/conext",
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
    };
  };
  resetResolvedAgentExtensionPathsCache();
  const originalReload = DefaultResourceLoader.prototype.reload;
  const originalWriteFile = fs.promises.writeFile;
  let releaseReload = () => {};
  const reloadStarted = Promise.withResolvers<void>();
  const writeStarted = Promise.withResolvers<void>();
  let released = false;
  const reloadRelease = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  DefaultResourceLoader.prototype.reload = async function delayedReload() {
    reloadStarted.resolve();
    await reloadRelease;
    return originalReload.call(this);
  };
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async (...args: unknown[]) => {
      writeStarted.resolve();
      return Reflect.apply(originalWriteFile, fs.promises, args);
    },
  });
  const agent: AgentConfig = {
    name: "conext-agent",
    description: "Concurrent extension agent",
    thinking: "off",
    systemPrompt: "Concurrent prompt.",
    source: "user",
    filePath: "conext-agent.md",
    skills: ["conext"],
    extensions: ["conext"],
  };
  const promise = runSingleAgent(
    cwd,
    [agent],
    "conext-agent",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseReload();
  };
  try {
    await reloadStarted.promise;
    await writeStarted.promise;
    releaseOnce();
    const outcome = await promise;
    expect(outcome.kind).toBe("completed");
    expect(outcome.result.exitCode).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    releaseOnce();
    await promise.catch(() => {});
  }
});

test("runSingleAgent extension resolution error reports missing names with sorted available names", async () => {
  const { cwd } = await setupTest();
  const extPath = path.join(cwd, ".pi", "extensions");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/zebra-ext",
        resolvedPath: path.join(extPath, "zebra-ext", "index.js"),
        sourceInfo: {
          path: path.join(extPath, "zebra-ext", "index.js"),
          source: ".pi/extensions/zebra-ext",
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
        path: ".pi/extensions/alpha-ext",
        resolvedPath: path.join(extPath, "alpha-ext", "index.js"),
        sourceInfo: {
          path: path.join(extPath, "alpha-ext", "index.js"),
          source: ".pi/extensions/alpha-ext",
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
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["missing-a", "missing-b"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Unknown extensions: "missing-a", "missing-b"',
    );
    expect(result.stderr).toContain("Available extensions:");
    expect(result.stderr).toContain("alpha-ext");
    expect(result.stderr).toContain("zebra-ext");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent returns error result when prompt file write fails", async () => {
  const { cwd } = await setupTest();
  const originalWriteFile = fs.promises.writeFile;
  const writeFileError = new Error("ENOSPC: no space left on device");
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async () => {
      throw writeFileError;
    },
  });
  const agent: AgentConfig = {
    ...hangAgent,
    name: "write-fail",
    systemPrompt: "Prompt that triggers a write failure.",
  };
  let leakedPromptDir: string | undefined;
  try {
    const { result } = await withMkdtempCapture(async (getTmpDir) => {
      const runResult = await runSingleAgent(
        cwd,
        [agent],
        "write-fail",
        "task",
        undefined,
        undefined,
        makeSubagentDetails,
        undefined,
        "off",
      );
      leakedPromptDir = getTmpDir();
      return runResult;
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to write prompt");
    expect(result.stderr).toContain("ENOSPC");
  } finally {
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    if (leakedPromptDir) {
      await fs.promises.rm(leakedPromptDir, { recursive: true, force: true });
    }
  }
});

test("runSingleAgent returns error result when prompt file write fails with non-Error value", async () => {
  const { cwd } = await setupTest();
  const originalWriteFile = fs.promises.writeFile;
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async () => {
      throw "disk full";
    },
  });
  const agent: AgentConfig = {
    ...hangAgent,
    name: "write-fail-string",
    systemPrompt: "Prompt that triggers a write failure.",
  };
  let leakedPromptDir: string | undefined;
  try {
    const { result } = await withMkdtempCapture(async (getTmpDir) => {
      const runResult = await runSingleAgent(
        cwd,
        [agent],
        "write-fail-string",
        "task",
        undefined,
        undefined,
        makeSubagentDetails,
        undefined,
        "off",
      );
      leakedPromptDir = getTmpDir();
      return runResult;
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to write prompt");
    expect(result.stderr).toContain("disk full");
  } finally {
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    if (leakedPromptDir) {
      await fs.promises.rm(leakedPromptDir, { recursive: true, force: true });
    }
  }
});
