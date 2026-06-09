import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agent/agents.js";
import {
  makeEmitUpdate,
  runSingleAgent,
  SubagentAbortError,
} from "../src/child/process.js";
import {
  appendSubagentResultContract,
  SUBAGENT_RESULT_CONTRACT,
} from "../src/child/prompt-contract.js";
import type { SingleResult } from "../src/shared/types.js";
import {
  resetResolvedAgentSkillArgsCache,
  resolveAgentSkillArgs,
} from "../src/shared/utils.js";
import {
  hangAgent,
  makeSubagentDetails,
  makeSubagentToolUpdateLine,
  setupHooks,
  setupTest,
  shellQuote,
  waitFor,
} from "./helpers.js";

setupHooks();

test("runSingleAgent reports unknown agents with available names", async () => {
  const result = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "missing",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.agentSource).toBe("unknown");
  expect(result.stderr).toBe(
    'Unknown agent: "missing". Available agents: "hang".',
  );
});

test("runSingleAgent reports default depth limit with effective max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "3";
  const result = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("depth 3/3");
});

test("runSingleAgent uses env-configured max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "4";
  process.env.PI_SUBAGENT_MAX_DEPTH = "5";
  const { cwd } = await setupTest();
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
});

test("runSingleAgent reports clamped env max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "10";
  process.env.PI_SUBAGENT_MAX_DEPTH = "99";
  const result = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("depth 10/10");
});

test("runSingleAgent truncates stderr to env-configured byte cap", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "7";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'abcdefghij' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.stderr).toBe("abcdefg");
});

test("runSingleAgent truncates multibyte stderr at valid UTF-8 byte boundaries", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "7";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'a😀b中c' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.stderr).toBe("a😀b");
  expect(Buffer.byteLength(result.stderr, "utf-8")).toBeLessThanOrEqual(7);
  expect(result.stderr).not.toContain("�");
});

test("runSingleAgent keeps empty stderr under configured byte cap", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "1";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.stderr).toBe("");
});

test("runSingleAgent caps spawn error stderr by configured byte limit", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "6";
  const { cwd } = await setupTest();
  const originalArgv1 = process.argv[1];
  const originalExecPath = process.execPath;
  process.argv[1] = "/non/existent/pi";
  process.execPath = "/non/existent/pi_exec";
  try {
    const result = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stderr, "utf-8")).toBeLessThanOrEqual(6);
    expect(result.stderr).not.toContain("�");
  } finally {
    if (originalArgv1 !== undefined) process.argv[1] = originalArgv1;
    process.execPath = originalExecPath;
  }
});

test("runSingleAgent attempts one injected sleep inhibitor after normal exit", async () => {
  const acquired: number[] = [];
  let releases = 0;
  const { cwd } = await setupTest();
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor(pid) {
        acquired.push(pid);
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  expect(acquired).toHaveLength(1);
  expect(Number.isFinite(acquired[0])).toBe(true);
  expect(releases).toBe(1);
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  expect(result.stderr).toBe("");
  expect(result.termination).toBeUndefined();
  expect(result.usage.input).toBe(1);
  expect(result.usage.output).toBe(1);
});

test("runSingleAgent skips sleep inhibitor acquisition when spawn has no PID", async () => {
  let acquisitionAttempts = 0;
  const { cwd } = await setupTest();
  const originalArgv1 = process.argv[1];
  const originalExecPath = process.execPath;
  process.argv[1] = "/non/existent/pi";
  process.execPath = "/non/existent/pi_exec";
  try {
    const result = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      false,
      {
        async acquireSleepInhibitor() {
          acquisitionAttempts += 1;
          return {
            async release() {},
          };
        },
      },
    );
    expect(acquisitionAttempts).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.finalOutput).toBe("");
    expect(result.termination).toBeUndefined();
  } finally {
    if (originalArgv1 !== undefined) process.argv[1] = originalArgv1;
    process.execPath = originalExecPath;
  }
});

test("runSingleAgent keeps acquisition and release failures invisible", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'child stderr' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const releaseFailure = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            throw new Error("release failed");
          },
        };
      },
    },
  );
  const acquisitionFailure = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        throw new Error("acquire failed");
      },
    },
  );
  expect(releaseFailure.exitCode).toBe(0);
  expect(releaseFailure.stderr).toBe("child stderr");
  expect(releaseFailure.finalOutput).toBe("done");
  expect(releaseFailure.termination).toBeUndefined();
  expect(acquisitionFailure.exitCode).toBe(0);
  expect(acquisitionFailure.stderr).toBe("child stderr");
  expect(acquisitionFailure.finalOutput).toBe("done");
  expect(acquisitionFailure.termination).toBeUndefined();
});

test("runSingleAgent settles immediate exit before delayed sleep inhibitor acquisition", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'delayed stderr' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"delayed done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const resultPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return new Promise(() => {});
      },
    },
  );
  const result = await Promise.race([
    resultPromise,
    Bun.sleep(500).then(() => new Error("timed out waiting for result")),
  ]);
  expect(result).not.toBeInstanceOf(Error);
  expect((result as SingleResult).exitCode).toBe(0);
  expect((result as SingleResult).finalOutput).toBe("delayed done");
  expect((result as SingleResult).stderr).toBe("delayed stderr");
});

test("runSingleAgent handles host abort before delayed sleep inhibitor acquisition resolves", async () => {
  let acquired = false;
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
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired = true;
        return new Promise(() => {});
      },
    },
  );
  await waitFor(
    () => acquired || undefined,
    "delayed sleep inhibitor acquisition",
  );
  controller.abort("host abort while acquiring");
  const error = await Promise.race([
    promise.then(
      () => undefined,
      (value: unknown) => value,
    ),
    Bun.sleep(500).then(() => new Error("timed out waiting for abort")),
  ]);
  expect(error).toBeInstanceOf(SubagentAbortError);
  expect((error as SubagentAbortError).result.termination?.cancelReason).toBe(
    "host abort while acquiring",
  );
});

test("runSingleAgent releases injected sleep inhibitor after cancellation", async () => {
  let releases = 0;
  let acquired = false;
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
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired = true;
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  await waitFor(() => acquired || undefined, "sleep inhibitor acquisition");
  controller.abort("cancelled");
  await expect(promise).rejects.toThrow("Subagent was aborted");
  await promise.catch((error: unknown) => {
    expect(error).toBeInstanceOf(SubagentAbortError);
    expect((error as SubagentAbortError).result.termination?.cancelReason).toBe(
      "cancelled",
    );
    expect((error as SubagentAbortError).result.stderr).toBe("");
  });
  expect(releases).toBe(1);
});

test("runSingleAgent releases injected sleep inhibitor after agent-end timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  expect(result.stderr).toBe("");
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
  expect(releases).toBe(1);
});

test("runSingleAgent releases injected sleep inhibitor after pre-aborted host signal", async () => {
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  controller.abort("host abort");
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  await expect(promise).rejects.toThrow("Subagent was aborted");
  await promise.catch((error: unknown) => {
    expect(error).toBeInstanceOf(SubagentAbortError);
    expect((error as SubagentAbortError).result.termination?.cancelReason).toBe(
      "host abort",
    );
    expect((error as SubagentAbortError).result.stderr).toBe("");
  });
  expect(releases).toBe(1);
});

test("runSingleAgent releases late-acquired sleep inhibitor handle after child completion", async () => {
  const releaseLog: string[] = [];
  let resolveAcquisition!: () => void;
  const acquisitionBarrier = new Promise<void>((resolve) => {
    resolveAcquisition = resolve;
  });
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        await acquisitionBarrier;
        return {
          async release() {
            releaseLog.push("released");
          },
        };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  resolveAcquisition();
  await Bun.sleep(20);
  expect(releaseLog).toEqual(["released"]);
});

test("runSingleAgent suppresses unhandled rejection from late-acquired release failure", async () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let resolveAcquisition!: () => void;
  const acquisitionBarrier = new Promise<void>((resolve) => {
    resolveAcquisition = resolve;
  });
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  try {
    const result = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      false,
      {
        async acquireSleepInhibitor() {
          await acquisitionBarrier;
          return {
            async release() {
              throw new Error("late release failure");
            },
          };
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    resolveAcquisition();
    await Bun.sleep(20);
    expect(unhandledRejections).toHaveLength(0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("runSingleAgent handles repeated release on the same handle silently", async () => {
  let releaseCalls = 0;
  const { cwd } = await setupTest();
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            releaseCalls += 1;
          },
        };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(releaseCalls).toBe(1);
});

test("runSingleAgent suppresses release failure on already-resolved handle", async () => {
  const { cwd } = await setupTest();
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            throw new Error("release on resolved handle");
          },
        };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
});

test("runSingleAgent keeps concurrent sleep inhibitors independent", async () => {
  const releasePath = path.join("release-held");
  const releaseCounts = { cancelled: 0, held: 0 };
  const acquired = { cancelled: false, held: false };
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
case "$*" in
  *cancelled-child*) trap 'exit 0' TERM; sleep 10 & wait $! ;;
  *held-child*) while [ ! -f release-held ]; do sleep 0.01; done; printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"held done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":5,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'; printf '%s\n' '{"type":"agent_end","messages":[]}'; exit 0 ;;
esac
`,
  });
  const controller = new AbortController();
  const cancelledPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "cancelled-child",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired.cancelled = true;
        return {
          async release() {
            releaseCounts.cancelled += 1;
          },
        };
      },
    },
  );
  const heldPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "held-child",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired.held = true;
        return {
          async release() {
            releaseCounts.held += 1;
          },
        };
      },
    },
  );
  await waitFor(
    () => (acquired.cancelled && acquired.held) || undefined,
    "concurrent sleep inhibitor acquisition",
  );
  controller.abort("cancelled child only");
  await expect(cancelledPromise).rejects.toThrow("Subagent was aborted");
  expect(releaseCounts.cancelled).toBe(1);
  expect(releaseCounts.held).toBe(0);
  await fs.promises.writeFile(path.join(cwd, releasePath), "release");
  const heldResult = await heldPromise;
  expect(heldResult.exitCode).toBe(0);
  expect(heldResult.finalOutput).toBe("held done");
  expect(heldResult.stderr).toBe("");
  expect(heldResult.usage.input).toBe(2);
  expect(heldResult.usage.output).toBe(3);
  expect(heldResult.termination).toBeUndefined();
  expect(releaseCounts.held).toBe(1);
});

test("runSingleAgent preserves default stdout drain after agent_end", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 0.05
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done after agent_end"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
exit 0
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done after agent_end");
});

test("runSingleAgent honors explicit lower agent-end grace", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const startedAt = Date.now();
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
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
    makeSubagentDetails,
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
    await waitFor(() => reloadStarted || undefined, "skill discovery start");
    await waitFor(() => writeStarted || undefined, "prompt write start");
    releaseOnce();
    const result = await promise;
    expect(result.exitCode).toBe(0);
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
  await expect(resolveAgentSkillArgs(cwd, ["warm"])).resolves.toEqual({
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
    const result = await runSingleAgent(
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
      makeSubagentDetails,
      undefined,
      "off",
    );
  } finally {
    Object.defineProperty(fs.promises, "mkdtemp", {
      value: originalMkdtemp,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  if (!result) throw new Error("result missing");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown skill: "missing-skill"');
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

test("nested activity triggers onUpdate without appending messages", async () => {
  const updates: { text: string; messageCount: number }[] = [];
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading file.ts"))}
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      const text = partial.content[0]?.text ?? "";
      const msgCount = partial.details.results[0]?.messages?.length ?? 0;
      updates.push({ text, messageCount: msgCount });
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.messages).toHaveLength(1);
  const nestedUpdate = updates.find(
    (u) => u.text === "subagent - Reading file.ts",
  );
  expect(nestedUpdate).toBeDefined();
  expect(nestedUpdate?.messageCount).toBe(1);
});

test("nested activity with sensitive keywords is redacted", async () => {
  let capturedText = "";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading secret-token.yaml"))}
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      capturedText = partial.content[0]?.text ?? "";
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(capturedText).toBe("(running...)");
});

test("nested activity handles no-message no-terminal child exit", async () => {
  const updates: { text: string; messageCount: number }[] = [];
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Grandchild running"))}
exit 0
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      const text = partial.content[0]?.text ?? "";
      const msgCount = partial.details.results[0]?.messages?.length ?? 0;
      updates.push({ text, messageCount: msgCount });
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.messages).toHaveLength(0);
  expect(result.progress?.activityText).toBe("subagent - Grandchild running");
  expect(updates).toContainEqual({
    text: "subagent - Grandchild running",
    messageCount: 0,
  });
});

test("child tool events replace nested activity in subsequent updates", async () => {
  const texts: string[] = [];
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Grandchild working"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"bash","arguments":{"command":"ls"}}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      texts.push(partial.content[0]?.text ?? "");
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(texts).toContain("subagent - Grandchild working");
  expect(texts.some((t) => t.includes("bash"))).toBe(true);
  const nestedIdx = texts.indexOf("subagent - Grandchild working");
  const toolIdx = texts.findIndex((t) => t.includes("bash"));
  expect(toolIdx).toBeGreaterThan(nestedIdx);
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

// Helper: build a minimal RuntimeResult with a tool-call message so deriveStreamingProgress produces activeToolActivity
function makeRuntimeWithToolCall(
  toolName: string,
  args: Record<string, unknown>,
) {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: toolName, arguments: args },
      ],
    },
  ] as Message[];
  return {
    agent: "test",
    agentSource: "user" as const,
    task: "task",
    exitCode: 0,
    finalOutput: "",
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    messages,
  } as SingleResult & { messages: Message[] };
}

test("makeEmitUpdate merge: inputSummary === toolName fallback does not overwrite parent inputSummary", () => {
  // deriveStreamingProgress produces inputSummary from makeToolPreview("subagent", ...) → "subagent: builder"
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);
  // Parser sends bare toolName fallback (inputSummary === toolName) — should retain parent's richer value
  emitUpdate({
    toolActivity: { toolName: "subagent", inputSummary: "subagent" },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: builder",
  });
});

test("makeEmitUpdate merge: inputSummary !== toolName overwrites parent inputSummary", () => {
  // deriveStreamingProgress produces inputSummary: "subagent" (bare toolName from makeToolPreview)
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);
  // Parser sends richer inputSummary from nested child (different from toolName "subagent")
  emitUpdate({
    toolActivity: { toolName: "subagent", inputSummary: "bash: scan src" },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "bash: scan src",
  });
});

test("makeEmitUpdate merge: incoming without inputSummary preserves parent inputSummary", () => {
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);
  // Incoming has no inputSummary — merge should keep parent's richer semantic value
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      child: { toolName: "bash", inputSummary: "bash: ls" },
    },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: builder",
    child: { toolName: "bash", inputSummary: "bash: ls" },
  });
});

test("makeEmitUpdate streaming integration: subagent preview starts with semantic target then updated to richer parser inputSummary", () => {
  // deriveStreamingProgress produces activeToolActivity with inputSummary from semantic lookup: "subagent: builder"
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const texts: string[] = [];
  const emitUpdate = makeEmitUpdate(
    result,
    (partial) => {
      texts.push(partial.content[0]?.text ?? "");
    },
    makeSubagentDetails,
  );
  // First call triggers deriveStreamingProgress and sets result.progress
  emitUpdate();
  // progress derived from messages: makeToolPreview("subagent", ...) → "subagent: builder" (semantic lookup)
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: builder",
  });
  expect(result.progress?.activityText).toBe("subagent: builder");
  // Parser sends richer nested child data — merge prefers incoming inputSummary
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "bash: scan src",
      child: { toolName: "bash", inputSummary: "bash: scan src" },
    },
  });
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    "bash: scan src",
  );
  // renderToolActivity walks full tree: parent + child joined with " - "
  expect(result.progress?.activityText).toBe("bash: scan src - bash: scan src");
});

test("runSingleAgent releases sleep inhibitor after spawn error with valid PID", async () => {
  const acquired: number[] = [];
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'spawn error stderr' >&2
exit 1
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor(pid) {
        acquired.push(pid);
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  expect(acquired).toHaveLength(1);
  expect(Number.isFinite(acquired[0])).toBe(true);
  expect(result.exitCode).toBe(1);
  expect(releases).toBe(1);
});

test("runSingleAgent agent-end timeout with empty output returns exit code 1", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.finalOutput).toBe("");
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

test("runSingleAgent writes unknown events to stderr when debug diagnostics enabled", async () => {
  const stderrWrite = process.stderr.write;
  const written: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' 'malformed json'
printf '%s\n' '{"type":"unknown_type","data":1}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  try {
    const result = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      true,
    );
    expect(result.exitCode).toBe(0);
    expect(written.some((w) => w.includes("malformed"))).toBe(true);
    expect(written.some((w) => w.includes("unknown"))).toBe(true);
  } finally {
    process.stderr.write = stderrWrite;
  }
});

test("runSingleAgent acquisition failure on one concurrent child does not affect the other", async () => {
  const releaseCounts = { failing: 0, succeeding: 0 };
  const acquired = { failing: false, succeeding: false };
  const releasePath = path.join("release-succeeding");
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
case "$*" in
  *failing-child*) exit 1 ;;
  *succeeding-child*) while [ ! -f release-succeeding ]; do sleep 0.01; done; printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"succeeding done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":5,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'; printf '%s\n' '{"type":"agent_end","messages":[]}'; exit 0 ;;
esac
`,
  });
  const failingPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "failing-child",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired.failing = true;
        throw new Error("acquire failed");
      },
    },
  );
  const succeedingPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "succeeding-child",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired.succeeding = true;
        return {
          async release() {
            releaseCounts.succeeding += 1;
          },
        };
      },
    },
  );
  await waitFor(
    () => (acquired.failing && acquired.succeeding) || undefined,
    "concurrent acquisition attempts",
  );
  const failingResult = await failingPromise;
  expect(failingResult.exitCode).toBe(1);
  expect(releaseCounts.failing).toBe(0);
  await fs.promises.writeFile(path.join(cwd, releasePath), "release");
  const succeedingResult = await succeedingPromise;
  expect(succeedingResult.exitCode).toBe(0);
  expect(succeedingResult.finalOutput).toBe("succeeding done");
  expect(releaseCounts.succeeding).toBe(1);
});

test("runSingleAgent default host adapter returns no-op handle on non-darwin platform", async () => {
  const { cwd } = await setupTest();
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  expect(result.stderr).toBe("");
});

describe("usage accumulation via runSingleAgent", () => {
  async function runUsageTest(piScript: string, options?: { debug?: boolean }) {
    const { cwd } = await setupTest({ piScript });
    return runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      options?.debug,
    );
  }

  test("assistant messages increment turns and aggregate usage fields", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"api":"fake","provider":"fake","model":"fake-model","usage":{"input":10,"output":5,"cacheRead":3,"cacheWrite":2,"totalTokens":15,"cost":{"total":0.5}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"api":"fake","provider":"fake","model":"fake-model-2","usage":{"input":20,"output":10,"cacheRead":7,"cacheWrite":4,"totalTokens":30,"cost":{"total":1.0}},"stopReason":"length","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(30);
    expect(result.usage.output).toBe(15);
    expect(result.usage.cacheRead).toBe(10);
    expect(result.usage.cacheWrite).toBe(6);
    expect(result.usage.cost).toBe(1.5);
    expect(result.usage.contextTokens).toBe(30);
    expect(result.model).toBe("thinking:off");
    expect(result.stopReason).toBe("length");
  });

  test("messages without usage keep defaults and increment turns", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no usage"}],"api":"fake","provider":"fake","model":"fake","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(0);
    expect(result.usage.output).toBe(0);
    expect(result.usage.cacheRead).toBe(0);
    expect(result.usage.cacheWrite).toBe(0);
    expect(result.usage.cost).toBe(0);
    expect(result.usage.contextTokens).toBe(0);
    expect(result.usage.contextWindowTokens).toBeUndefined();
  });

  test("non-assistant messages do not affect usage", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"tool result"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":5,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":10,"cost":{"total":0.1}},"timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(0);
    expect(result.usage.input).toBe(0);
    expect(result.usage.output).toBe(0);
    expect(result.usage.cacheRead).toBe(0);
    expect(result.usage.cacheWrite).toBe(0);
    expect(result.usage.cost).toBe(0);
    expect(result.usage.contextTokens).toBe(0);
  });

  test("missing cost keeps cost at zero", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no cost"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(1);
    expect(result.usage.output).toBe(2);
    expect(result.usage.cost).toBe(0);
  });

  test("missing totalTokens keeps contextTokens at zero", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no totalTokens"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.contextTokens).toBe(0);
  });

  test("contextWindowTokens omitted when model not found", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no context window"}],"api":"fake","provider":"fake","model":"nonexistent","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.contextWindowTokens).toBeUndefined();
  });

  test("multiple assistant messages accumulate cache and cost correctly", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":100,"output":50,"cacheRead":10,"cacheWrite":5,"totalTokens":150,"cost":{"total":2.5}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":200,"output":100,"cacheRead":20,"cacheWrite":10,"totalTokens":300,"cost":{"total":5.0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"third"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":50,"output":25,"cacheRead":5,"cacheWrite":2,"totalTokens":75,"cost":{"total":1.25}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(3);
    expect(result.usage.input).toBe(350);
    expect(result.usage.output).toBe(175);
    expect(result.usage.cacheRead).toBe(35);
    expect(result.usage.cacheWrite).toBe(17);
    expect(result.usage.cost).toBe(8.75);
    expect(result.usage.contextTokens).toBe(75);
  });

  test("model and stopReason set from last assistant message", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"api":"fake","provider":"fake","model":"model-a","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"api":"fake","provider":"fake","model":"model-b","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"length","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("thinking:off");
    expect(result.stopReason).toBe("length");
  });

  test("contextWindowTokens set from valid model provider and model", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"openai","model":"gpt-4","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.contextWindowTokens).toBe(8192);
  });
});

test("tool_result_end event sets toolResultCompleted flag", async () => {
  const piScript = `#!/bin/sh
printf '%s\n' '{"type":"tool_result_end","message":{"role":"toolResult","content":[{"type":"text","text":"tool output"}],"api":"fake","provider":"fake","model":"fake","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.progress?.toolResultCompleted).toBe(true);
});

test("tool_execution_update event updates activity text", async () => {
  const piScript = `#!/bin/sh
printf '%s\n' '{"type":"tool_execution_update","toolName":"bash","partialResult":{"content":[],"details":{}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  let lastUpdate: unknown;
  const result = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (update) => {
      lastUpdate = update;
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(lastUpdate).toBeDefined();
});

test("debug event diagnostics logs malformed JSON", async () => {
  const piScript = `#!/bin/sh
printf '%s\n' 'not valid json'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      true,
    );
    expect(result.exitCode).toBe(0);
    expect(
      stderrChunks.some((chunk) =>
        chunk.includes("[pi-subagent:unknown-event] malformed:"),
      ),
    ).toBe(true);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("debug event diagnostics logs unknown event types", async () => {
  const piScript = `#!/bin/sh
printf '%s\n' '{"type":"unknown_type","data":"test"}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      true,
    );
    expect(result.exitCode).toBe(0);
    expect(
      stderrChunks.some((chunk) =>
        chunk.includes("[pi-subagent:unknown-event] unknown:"),
      ),
    ).toBe(true);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("pre-aborted signal triggers immediate termination", async () => {
  const piScript = `#!/bin/sh
sleep 10
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const controller = new AbortController();
  controller.abort("pre-aborted");
  try {
    await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      controller.signal,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    throw new Error("Expected SubagentAbortError");
  } catch (error) {
    expect(error).toBeInstanceOf(SubagentAbortError);
    const abortError = error as SubagentAbortError;
    expect(abortError.result.termination).toBeDefined();
    expect(abortError.result.termination?.cancelReason).toBe("pre-aborted");
  }
});
