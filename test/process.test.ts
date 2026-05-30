import { expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agent/agents.js";
import { runSingleAgent } from "../src/child/process.js";
import {
  appendSubagentResultContract,
  SUBAGENT_RESULT_CONTRACT,
} from "../src/child/prompt-contract.js";
import type { SubagentDetails } from "../src/shared/types.js";
import { setupHooks, setupTest, waitFor } from "./helpers.js";

setupHooks();

const makeDetails = (results: SubagentDetails["results"]): SubagentDetails => ({
  mode: "single",
  agentScope: "both",
  projectAgentsDir: null,
  results,
});

const hangAgent: AgentConfig = {
  name: "hang",
  description: "Test agent",
  thinking: "off",
  systemPrompt: "Test agent prompt.",
  source: "user",
  filePath: "hang.md",
};

test("runSingleAgent reports unknown agents with available names", async () => {
  const result = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "missing",
    "task",
    undefined,
    undefined,
    makeDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.agentSource).toBe("unknown");
  expect(result.stderr).toBe(
    'Unknown agent: "missing". Available agents: "hang".',
  );
});

test("runSingleAgent cancels cleanly with nonstandard abort reason", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeDetails,
    undefined,
    "off",
  );
  controller.abort(null);
  await expect(promise).rejects.toThrow("Subagent was aborted");
});

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
  let reloadStarted = false;
  let writeStarted = false;
  let released = false;
  const reloadRelease = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  DefaultResourceLoader.prototype.reload = async function delayedReload() {
    reloadStarted = true;
    await reloadRelease;
    return originalReload.call(this);
  };
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async (...args: unknown[]) => {
      writeStarted = true;
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
    makeDetails,
    undefined,
    "off",
  );
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseReload();
  };
  try {
    await waitFor(() => reloadStarted || undefined, "skill discovery start");
    await waitFor(() => writeStarted || undefined, "prompt write start");
    releaseOnce();
    const result = await promise;
    expect(result.exitCode).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    Object.defineProperty(fs.promises, "writeFile", {
      configurable: true,
      value: originalWriteFile,
    });
    releaseOnce();
    await promise.catch(() => {});
  }
});

test("runSingleAgent cleans prompt temp file when skill resolution fails after prompt creation", async () => {
  const { cwd } = await setupTest();
  const originalMkdtemp = fs.promises.mkdtemp;
  let tmpDir: string | undefined;
  Object.defineProperty(fs.promises, "mkdtemp", {
    configurable: true,
    value: async (...args: unknown[]) => {
      const dir = Reflect.apply(
        originalMkdtemp,
        fs.promises,
        args,
      ) as Promise<string>;
      tmpDir = await dir;
      return tmpDir;
    },
  });
  const agent: AgentConfig = {
    name: "badskill",
    description: "Bad skill",
    thinking: "off",
    systemPrompt: "Prompt that creates a temp file.",
    source: "user",
    filePath: "badskill.md",
    skills: ["missing-skill"],
  };
  let result: Awaited<ReturnType<typeof runSingleAgent>> | undefined;
  try {
    result = await runSingleAgent(
      cwd,
      [agent],
      "badskill",
      "task",
      undefined,
      undefined,
      makeDetails,
      undefined,
      "off",
    );
  } finally {
    Object.defineProperty(fs.promises, "mkdtemp", {
      configurable: true,
      value: originalMkdtemp,
    });
  }
  if (!result) throw new Error("result missing");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown skill: "missing-skill"');
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

test("SUBAGENT_RESULT_CONTRACT preserves outcome-only result contract", () => {
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(
    /End your final response with exactly one line:/,
  );
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(
    /^\s*- Outcome: <short, single, compact lower-case sentence>\./m,
  );
  expect(SUBAGENT_RESULT_CONTRACT).not.toMatch(/standardized result output/i);
});

test("appendSubagentResultContract appends contract to prompt", () => {
  const result = appendSubagentResultContract("Task: foo");
  expect(result.startsWith("Task: foo\n\n")).toBe(true);
  expect(result.endsWith(SUBAGENT_RESULT_CONTRACT)).toBe(true);
});
