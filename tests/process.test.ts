import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agent/agents.js";
import { discoverAgentsAsync } from "../src/agent/agents.js";
import type { ModelRegistry } from "../src/child/model-resolution.js";
import type { RunSingleAgentResult } from "../src/child/process.js";
import {
  getAgentEndTimeoutExitCode,
  hasCompletedAgentOutput,
  runSingleAgent,
} from "../src/child/process.js";
import {
  resolvePackageExtensionPath,
  resolveSamplingExtensionPath,
} from "../src/child/process-utils.js";
import defaultSamplingExtension, {
  patchPayload,
} from "../src/child/sampling-extension.js";
import { parseSamplingParams } from "../src/shared/sampling.js";
import type { SingleResult } from "../src/shared/types.js";
import { TOOL_RESULT_FAILED_MESSAGE } from "../src/shared/types.js";
import {
  resetResolvedAgentExtensionPathsCache,
  resetResolvedAgentSkillArgsCache,
  resolveAgentSkillArgs,
} from "../src/shared/utils.js";
import {
  CAPTURE_ARGS_PI_SCRIPT,
  emitAgentEnd,
  emitMessageEnd,
  flagValues,
  hangAgent,
  installFakePi,
  makeAssistantMessage,
  makeModelAgent,
  makeRuntimeResult,
  makeSingleResult,
  makeSubagentDetails,
  registryFixture,
  setupFakePi,
  setupHooks,
  setupTest,
  waitFor,
  withEnv,
  withMkdtempCapture,
} from "./helpers.js";

setupHooks();

type CapturableParentModel = {
  provider?: string | undefined;
  id?: string | undefined;
};

async function runCapturedModelAgent(
  agent: AgentConfig,
  parentModel: CapturableParentModel | undefined,
  parentThinking: AgentConfig["thinking"] = "off",
  options?: { registry?: ModelRegistry },
): Promise<{ args: string[]; result: SingleResult }> {
  const { cwd } = await setupTest({
    piScript: CAPTURE_ARGS_PI_SCRIPT,
  });
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    parentModel,
    parentThinking ?? "off",
    false,
    options,
  );
  expect(result.exitCode).toBe(0);
  return {
    args: fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n"),
    result,
  };
}

async function captureRunSingleAgentArgs(
  agent: AgentConfig,
  parentModel: CapturableParentModel | undefined,
  options: { registry?: ModelRegistry } = { registry: registryFixture([]) },
): Promise<string[]> {
  return (await runCapturedModelAgent(agent, parentModel, "off", options)).args;
}

test("runSingleAgent reports unknown agents with available names", async () => {
  const { result } = await runSingleAgent(
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
  process.env.PI_SUBAGENT_DEPTH = "5";
  const { result } = await runSingleAgent(
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
  expect(result.stderr).toContain("depth 5/5");
});

test("runSingleAgent uses env-configured max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "4";
  process.env.PI_SUBAGENT_MAX_DEPTH = "5";
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
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
  const { result } = await runSingleAgent(
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

test.each([
  {
    name: "runSingleAgent truncates stderr to env-configured byte cap",
    maxStderrBytes: "7",
    piScript: `#!/bin/sh
printf 'abcdefghij' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    expectedStderr: "abcdefg",
  },
  {
    name: "runSingleAgent keeps empty stderr under configured byte cap",
    maxStderrBytes: "1",
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    expectedStderr: "",
  },
])("$name", async (row) => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = row.maxStderrBytes;
  const { cwd } = await setupTest({
    piScript: row.piScript,
  });
  const { result } = await runSingleAgent(
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
  expect(result.stderr).toBe(row.expectedStderr);
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
  const { result } = await runSingleAgent(
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

test("runSingleAgent caps spawn error stderr by configured byte limit", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "6";
  const { cwd } = await setupTest();
  const originalArgv1 = process.argv[1];
  const originalExecPath = process.execPath;
  process.argv[1] = "/non/existent/pi";
  process.execPath = "/non/existent/pi_exec";
  try {
    const { result } = await runSingleAgent(
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

test("runSingleAgent routes sleep inhibitor acquisition to the orchestrator PID", async () => {
  const acquired: number[] = [];
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'child pid %s' "$$" >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
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
  const childPid = Number(result.stderr.replace("child pid ", ""));
  expect(acquired).toEqual([process.pid]);
  expect(acquired[0]).not.toBe(childPid);
  expect(releases).toBe(1);
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  expect(result.stderr).toMatch(/^child pid \d+$/);
  expect(result.termination).toBeUndefined();
  expect(result.usage.input).toBe(1);
  expect(result.usage.output).toBe(1);
});

test("runSingleAgent rejects invalid orchestrator PIDs before sleep inhibitor acquisition", async () => {
  for (const orchestratorPid of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    let acquisitionAttempts = 0;
    const { cwd } = await setupTest();
    const { result } = await runSingleAgent(
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
        getOrchestratorPid() {
          return orchestratorPid;
        },
        async acquireSleepInhibitor() {
          acquisitionAttempts += 1;
          return {
            async release() {},
          };
        },
      },
    );
    expect(acquisitionAttempts).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    expect(result.termination).toBeUndefined();
  }
});

test("runSingleAgent handles throwing getOrchestratorPid gracefully", async () => {
  let acquisitionAttempts = 0;
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
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
      getOrchestratorPid() {
        throw new Error("pid resolution failed");
      },
      async acquireSleepInhibitor() {
        acquisitionAttempts += 1;
        return {
          async release() {},
        };
      },
    },
  );
  expect(acquisitionAttempts).toBe(0);
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  expect(result.termination).toBeUndefined();
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
  const { result: releaseFailure } = await runSingleAgent(
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
  const { result: acquisitionFailure } = await runSingleAgent(
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

test("runSingleAgent settles immediate exit before delayed orchestrator sleep inhibitor acquisition", async () => {
  let acquiredPid: number | undefined;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'delayed stderr' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"delayed done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const outcome = await runSingleAgent(
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
        acquiredPid = pid;
        return new Promise(() => {});
      },
    },
  );
  expect(acquiredPid).toBe(process.pid);
  expect(outcome.kind).toBe("completed");
  expect(outcome.result.exitCode).toBe(0);
  expect(outcome.result.finalOutput).toBe("delayed done");
  expect(outcome.result.stderr).toBe("delayed stderr");
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
  const outcome = await promise;
  expect(outcome.kind).toBe("aborted");
  expect(outcome.result.termination?.cancelReason).toBe(
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
  const cancelledOutcome = await promise;
  expect(cancelledOutcome.kind).toBe("aborted");
  expect(cancelledOutcome.result.termination?.cancelReason).toBe("cancelled");
  expect(cancelledOutcome.result.stderr).toBe("");
  expect(releases).toBe(1);
});

type AgentEndTimeoutScenario = {
  result: SingleResult;
  releases: number;
  elapsedMs: number;
};

/**
 * One spawn per distinct agent-end-timeout child behavior: the
 * inhibitor-release and explicit-grace cases share this byte-identical
 * fake-child run so the behavior spawns exactly once per layer.
 */
let sharedAgentEndTimeoutScenario: Promise<AgentEndTimeoutScenario> | undefined;

function runAgentEndTimeoutScenario(): Promise<AgentEndTimeoutScenario> {
  sharedAgentEndTimeoutScenario ??= (async () => {
    const scenario = await withEnv(
      { PI_SUBAGENT_AGENT_END_GRACE_MS: "25" },
      async () => {
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
        const startedAt = Date.now();
        const { result } = await runSingleAgent(
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
        return { result, releases, elapsedMs: Date.now() - startedAt };
      },
    );
    return scenario;
  })();
  return sharedAgentEndTimeoutScenario;
}

test("runSingleAgent releases injected sleep inhibitor after agent-end timeout", async () => {
  const { result, releases } = await runAgentEndTimeoutScenario();
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
  const preAbortedOutcome = await promise;
  expect(preAbortedOutcome.kind).toBe("aborted");
  expect(preAbortedOutcome.result.termination?.cancelReason).toBe("host abort");
  expect(preAbortedOutcome.result.stderr).toBe("");
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
  const { result } = await runSingleAgent(
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
    const { result } = await runSingleAgent(
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
  const { result } = await runSingleAgent(
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
  const { result } = await runSingleAgent(
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
  const cancelledOutcome2 = await cancelledPromise;
  expect(cancelledOutcome2.kind).toBe("aborted");
  expect(releaseCounts.cancelled).toBe(1);
  expect(releaseCounts.held).toBe(0);
  await fs.promises.writeFile(path.join(cwd, releasePath), "release");
  const heldResult = await heldPromise;
  expect(heldResult.kind).toBe("completed");
  expect(heldResult.result.exitCode).toBe(0);
  expect(heldResult.result.finalOutput).toBe("held done");
  expect(heldResult.result.stderr).toBe("");
  expect(heldResult.result.usage.input).toBe(2);
  expect(heldResult.result.usage.output).toBe(3);
  expect(heldResult.result.termination).toBeUndefined();
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
  const { result } = await runSingleAgent(
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
  const { result, elapsedMs } = await runAgentEndTimeoutScenario();
  expect(elapsedMs).toBeLessThan(500);
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
  const nonStandardOutcome = await promise;
  expect(nonStandardOutcome.kind).toBe("aborted");
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

test("runSingleAgent cleans prompt temp file when skill resolution fails after prompt creation", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    name: "badskill",
    description: "Bad skill",
    thinking: "off",
    systemPrompt: "Prompt that creates a temp file.",
    source: "user",
    filePath: "badskill.md",
    skills: ["missing-skill"],
  };
  let _result: SingleResult | undefined;
  const getTmpDir = await withMkdtempCapture(async (getTmpDir) => {
    const { result } = await runSingleAgent(
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
    _result = result;
    return getTmpDir;
  });
  if (!_result) throw new Error("result missing");
  expect(_result.exitCode).toBe(1);
  expect(_result.stderr).toContain('Unknown skill: "missing-skill"');
  const tmpDir = getTmpDir();
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

test("runSingleAgent cleans prompt temp file when replacePrompt true and skill resolution fails", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    name: "replace-badskill",
    description: "Replace bad skill",
    thinking: "off",
    systemPrompt: "Replacement prompt that creates a temp file.",
    replacePrompt: true,
    source: "user",
    filePath: "replace-badskill.md",
    skills: ["missing-skill"],
  };
  let _result: SingleResult | undefined;
  const getTmpDir = await withMkdtempCapture(async (getTmpDir) => {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "replace-badskill",
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
  expect(_result.stderr).toContain('Unknown skill: "missing-skill"');
  const tmpDir = getTmpDir();
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

test("runSingleAgent cleans prompt temp file when extension resolution fails after prompt creation", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    name: "badext",
    description: "Bad extension",
    thinking: "off",
    systemPrompt: "Prompt that creates a temp file.",
    source: "user",
    filePath: "badext.md",
    extensions: ["missing-ext"],
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
  expect(_result.stderr).toContain('Unknown extension: "missing-ext"');
  const tmpDir = getTmpDir();
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

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

test("runSingleAgent releases sleep inhibitor after spawn error with valid PID", async () => {
  const acquired: number[] = [];
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'spawn error stderr' >&2
exit 1
`,
  });
  const { result } = await runSingleAgent(
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
  const { result } = await runSingleAgent(
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

test("runSingleAgent treats earlier assistant text as completed output after agent-end timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"earlier done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"bash","arguments":{"command":"pwd"}}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const { result } = await runSingleAgent(
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
  expect(result.finalOutput).toBe("earlier done");
  expect(result.messages).toHaveLength(2);
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

describe("agent_end message snapshot rebuild", () => {
  async function runSnapshotScript(lines: string[]): Promise<SingleResult> {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
${lines.join("\n")}
exit 0
`,
    });
    const { result } = await runSingleAgent(
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
    return result;
  }

  test("non-empty agent_end messages restore missed final streamed message", async () => {
    const streamed = makeAssistantMessage("streamed", {
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { total: 0.1 },
      },
    });
    const missed = makeAssistantMessage("missed final", {
      usage: {
        input: 3,
        output: 4,
        cacheRead: 1,
        cacheWrite: 2,
        totalTokens: 7,
        cost: { total: 0.2 },
      },
      stopReason: "length",
    });
    const result = await runSnapshotScript([
      emitMessageEnd(streamed),
      emitAgentEnd([streamed, missed]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("missed final");
    expect(result.messages).toHaveLength(2);
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(4);
    expect(result.usage.output).toBe(6);
    expect(result.usage.cacheRead).toBe(1);
    expect(result.usage.cacheWrite).toBe(2);
    expect(result.usage.cost).toBeCloseTo(0.3);
    expect(result.stopReason).toBe("length");
  });

  test("empty agent_end messages preserve streamed state", async () => {
    const streamed = makeAssistantMessage("streamed only", {
      usage: {
        input: 5,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { total: 0.4 },
      },
      stopReason: "stop",
    });
    const result = await runSnapshotScript([
      emitMessageEnd(streamed),
      emitAgentEnd([]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("streamed only");
    expect(result.messages).toHaveLength(1);
    expect(result.usage.input).toBe(5);
    expect(result.usage.output).toBe(6);
    expect(result.usage.cost).toBe(0.4);
    expect(result.stopReason).toBe("stop");
  });

  test("snapshot rebuild recomputes derived result fields", async () => {
    const stale = makeAssistantMessage("stale", {
      usage: {
        input: 100,
        output: 200,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 300,
        cost: { total: 9 },
      },
      stopReason: "length",
      errorMessage: "stale error",
    });
    const authoritative = makeAssistantMessage("authoritative", {
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 6,
        cost: { total: 0.7 },
      },
      stopReason: "error",
      errorMessage: "final error",
    });
    const result = await runSnapshotScript([
      emitMessageEnd(stale),
      emitAgentEnd([authoritative]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("authoritative");
    expect(result.messages).toHaveLength(1);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(2);
    expect(result.usage.output).toBe(3);
    expect(result.usage.cacheRead).toBe(4);
    expect(result.usage.cacheWrite).toBe(5);
    expect(result.usage.cost).toBe(0.7);
    expect(result.usage.contextTokens).toBe(6);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("final error");
  });
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
    const { result } = await runSingleAgent(
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
  expect(failingResult.kind).toBe("completed");
  expect(failingResult.result.exitCode).toBe(1);
  expect(releaseCounts.failing).toBe(0);
  await fs.promises.writeFile(path.join(cwd, releasePath), "release");
  const succeedingResult = await succeedingPromise;
  expect(succeedingResult.kind).toBe("completed");
  expect(succeedingResult.result.exitCode).toBe(0);
  expect(succeedingResult.result.finalOutput).toBe("succeeding done");
  expect(releaseCounts.succeeding).toBe(1);
});

test("runSingleAgent default host adapter returns no-op handle on non-darwin platform", async () => {
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
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
  async function runUsageTest(
    piScript: string,
    options?: { debug?: boolean },
  ): Promise<SingleResult> {
    const { cwd } = await setupTest({ piScript });
    const { result } = await runSingleAgent(
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
    return result;
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
    expect(result.model).toBe("off");
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

  test.each([
    {
      name: "non-assistant messages do not affect usage",
      piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"tool result"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":5,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":10,"cost":{"total":0.1}},"timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
      expectedTurns: 0,
      expectedInput: 0,
      expectedOutput: 0,
      expectedCacheRead: 0,
      expectedCacheWrite: 0,
      expectedCost: 0,
      expectedContextTokens: 0,
    },
    {
      name: "multiple assistant messages accumulate cache and cost correctly",
      piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":100,"output":50,"cacheRead":10,"cacheWrite":5,"totalTokens":150,"cost":{"total":2.5}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":200,"output":100,"cacheRead":20,"cacheWrite":10,"totalTokens":300,"cost":{"total":5.0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"third"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":50,"output":25,"cacheRead":5,"cacheWrite":2,"totalTokens":75,"cost":{"total":1.25}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
      expectedTurns: 3,
      expectedInput: 350,
      expectedOutput: 175,
      expectedCacheRead: 35,
      expectedCacheWrite: 17,
      expectedCost: 8.75,
      expectedContextTokens: 75,
    },
  ])("$name", async (row) => {
    const piScript = row.piScript;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(row.expectedTurns);
    expect(result.usage.input).toBe(row.expectedInput);
    expect(result.usage.output).toBe(row.expectedOutput);
    expect(result.usage.cacheRead).toBe(row.expectedCacheRead);
    expect(result.usage.cacheWrite).toBe(row.expectedCacheWrite);
    expect(result.usage.cost).toBe(row.expectedCost);
    expect(result.usage.contextTokens).toBe(row.expectedContextTokens);
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

  test("model and stopReason set from last assistant message", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"api":"fake","provider":"fake","model":"model-a","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"api":"fake","provider":"fake","model":"model-b","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"length","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("off");
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
  const { result } = await runSingleAgent(
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
  const { result } = await runSingleAgent(
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

test.each([
  {
    name: "debug event diagnostics logs malformed JSON",
    piScript: `#!/bin/sh
printf '%s\n' 'not valid json'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    expectedStderrChunk: "[pi-subagent:unknown-event] malformed:",
  },
  {
    name: "debug event diagnostics logs unknown event types",
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"unknown_type","data":"test"}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    expectedStderrChunk: "[pi-subagent:unknown-event] unknown:",
  },
])("$name", async (row) => {
  const piScript = row.piScript;
  const { cwd } = await setupTest({ piScript });
  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    const { result } = await runSingleAgent(
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
      stderrChunks.some((chunk) => chunk.includes(row.expectedStderrChunk)),
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
  const outcome = await runSingleAgent(
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
  expect(outcome.kind).toBe("aborted");
  expect(outcome.result.termination).toBeDefined();
  expect(outcome.result.termination?.cancelReason).toBe("pre-aborted");
});

test("runSingleAgent injects the complete extension", async () => {
  const args = await captureRunSingleAgentArgs(makeModelAgent({}), undefined);
  expect(args).toContain("--extension");
  const extPaths = flagValues(args, "--extension");
  expect(extPaths.length).toBe(1);
  expect(extPaths[0] ?? "").toContain("complete-extension");
});

test("runSingleAgent omits --tools when agent has no tools", async () => {
  const args = await captureRunSingleAgentArgs(makeModelAgent({}), undefined);
  expect(args).not.toContain("--tools");
});

test("runSingleAgent appends complete to the agent tool allowlist", async () => {
  const agent = makeModelAgent({ tools: ["read", "write"] });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["read", "write", "complete"]);
  expect(agent.tools).toEqual(["read", "write"]);
});

test("runSingleAgent preserves existing complete in the tool allowlist", async () => {
  const agent = makeModelAgent({ tools: ["read", "complete", "write"] });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["read", "complete", "write"]);
  expect(agent.tools).toEqual(["read", "complete", "write"]);
});

test("runSingleAgent injects complete into an empty tool allowlist", async () => {
  const agent = makeModelAgent({ tools: [] });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["complete"]);
  expect(agent.tools).toEqual([]);
});

test("runSingleAgent deduplicates complete in the tool allowlist", async () => {
  const agent = makeModelAgent({
    tools: ["read", "complete", "complete", "write", "complete"],
  });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["read", "complete", "write"]);
  expect(agent.tools).toEqual([
    "read",
    "complete",
    "complete",
    "write",
    "complete",
  ]);
});

test.each([
  {
    name: "runSingleAgent prefers toolResult details.outcome over assistant arguments.outcome",
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Assistant outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Tool outcome beats assistant"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    expectedOutcome: "Assistant outcome",
  },
  {
    name: "runSingleAgent handles multiple complete calls, newer invalid/blank calls do not block older valid outcomes",
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"First valid"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"First valid"}}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-2","name":"complete","arguments":{"outcome":"   "}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-2","details":{"outcome":"   "}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    expectedOutcome: "First valid",
  },
])("$name", async (row) => {
  const piScript = row.piScript;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
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
  expect(result.outcome).toBe(row.expectedOutcome);
});

test("runSingleAgent ignores blank or malformed outcomes", async () => {
  const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"   "}}]}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
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
  expect(result.outcome).toBeUndefined();
});

test("runSingleAgent ignores outcome on failed complete call", async () => {
  const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Should be ignored"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
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
  expect(result.outcome).toBe("Should be ignored");
});

test("runSingleAgent preserves outcome during agent-end timeout with no assistant text", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Timed out outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Timed out outcome"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const { result } = await runSingleAgent(
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
  expect(result.outcome).toBe("Timed out outcome");
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

test("runSingleAgent deletes extracted outcome when child exits non-zero", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Should be deleted"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Should be deleted"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 1
`,
  });
  const { result } = await runSingleAgent(
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
  expect(result.outcome).toBeUndefined();
});

test("runSingleAgent deletes extracted outcome when host aborts after outcome", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Aborted outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Aborted outcome"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
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
  controller.abort("host abort after outcome");
  const outcome = await promise;
  expect(outcome.kind).toBe("aborted");
  expect(outcome.result.outcome).toBeUndefined();
  expect(outcome.result.termination?.cancelReason).toBe(
    "host abort after outcome",
  );
});

describe("parseSamplingParams", () => {
  test.each([
    {
      name: "parses valid full sampling parameters",
      params: '{"temperature":0.5,"topP":0.8}',
      expectedTemperature: 0.5,
      expectedTopP: 0.8,
    },
    {
      name: "accepts boundary values 0 and 1",
      params: '{"temperature":0,"topP":1}',
      expectedTemperature: 0,
      expectedTopP: 1,
    },
  ])("$name", (row) => {
    const res = parseSamplingParams(row.params);
    expect(res).toEqual({
      temperature: row.expectedTemperature,
      topP: row.expectedTopP,
    });
  });

  test.each([
    {
      name: "parses valid single temperature parameter",
      params: '{"temperature":0.7}',
      expectedTemperature: 0.7,
    },
    {
      name: "ignores unsupported keys",
      params: '{"temperature":0.5,"unsupported":123}',
      expectedTemperature: 0.5,
    },
  ])("$name", (row) => {
    const res = parseSamplingParams(row.params);
    expect(res).toEqual({ temperature: row.expectedTemperature });
  });

  test("parses valid single topP parameter", () => {
    const res = parseSamplingParams('{"topP":0.1}');
    expect(res).toEqual({ topP: 0.1 });
  });

  test("returns undefined for missing or empty env val", () => {
    expect(parseSamplingParams()).toBeUndefined();
    expect(parseSamplingParams("")).toBeUndefined();
  });

  test("returns undefined for malformed JSON", () => {
    expect(parseSamplingParams("{invalid}")).toBeUndefined();
  });

  test.each([
    {
      name: "returns undefined for non-object JSON",
      params1: "42",
      params2: '"string"',
      params3: "[]",
    },
    {
      name: "ignores invalid topP values",
      params1: '{"topP":1.1}',
      params2: '{"topP":-0.01}',
      params3: '{"topP":null}',
    },
    {
      name: "returns undefined for unsupported-only and invalid-only inputs",
      params1: '{"unsupported":123}',
      params2: '{"temperature":-1}',
      params3: '{"topP":2}',
    },
  ])("$name", (row) => {
    expect(parseSamplingParams(row.params1)).toBeUndefined();
    expect(parseSamplingParams(row.params2)).toBeUndefined();
    expect(parseSamplingParams(row.params3)).toBeUndefined();
  });

  test("ignores invalid temperature values", () => {
    expect(parseSamplingParams('{"temperature":1.5}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":-0.1}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":"0.5"}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":NaN}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":Infinity}')).toBeUndefined();
  });

  test("accepts valid value when other value is invalid in both directions", () => {
    const res1 = parseSamplingParams('{"temperature":0.5,"topP":1.5}');
    expect(res1).toEqual({ temperature: 0.5 });
    const res2 = parseSamplingParams('{"temperature":-0.5,"topP":0.8}');
    expect(res2).toEqual({ topP: 0.8 });
  });
});

describe("patchPayload", () => {
  test("patches flat payloads without mutating original", () => {
    const payload = Object.freeze({ model: "claude-3-5", messages: [] });
    const params = { temperature: 0.2, topP: 0.9 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "claude-3-5",
      messages: [],
      temperature: 0.2,
      top_p: 0.9,
    });
    expect(patched).not.toBe(payload);
  });

  test("patches flat payload with temperature only", () => {
    const payload = { model: "gpt-4", prompt: "hi" };
    const params = { temperature: 0.5 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gpt-4",
      prompt: "hi",
      temperature: 0.5,
    });
  });

  test("patches flat payload with topP only", () => {
    const payload = { model: "gpt-4", prompt: "hi" };
    const params = { topP: 0.3 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gpt-4",
      prompt: "hi",
      top_p: 0.3,
    });
  });

  test("patches generationConfig payloads without mutating original", () => {
    const innerConfig = Object.freeze({ maxOutputTokens: 100 });
    const payload = Object.freeze({
      model: "gemini",
      generationConfig: innerConfig,
    });
    const params = { temperature: 0.4, topP: 0.7 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gemini",
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.4,
        topP: 0.7,
      },
    });
    expect(patched).not.toBe(payload);
    expect(patched["generationConfig"]).not.toBe(innerConfig);
  });

  test("patches generationConfig payload with single field", () => {
    const payload = { model: "gemini", generationConfig: { topP: 0.1 } };
    const params = { temperature: 0.9 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gemini",
      generationConfig: {
        topP: 0.1,
        temperature: 0.9,
      },
    });
  });

  test("overwrites existing sampling keys in flat payload", () => {
    const payload = { model: "gpt-4", temperature: 0.9, top_p: 0.2 };
    const params = { temperature: 0.5, topP: 0.8 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gpt-4",
      temperature: 0.5,
      top_p: 0.8,
    });
  });

  test("treats non-object generationConfig as empty object", () => {
    const payload = { model: "gemini", generationConfig: null };
    const params = { temperature: 0.3, topP: 0.6 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gemini",
      generationConfig: { temperature: 0.3, topP: 0.6 },
    });
  });
});

describe("sampling extension hook registration and execution", () => {
  function makeTrackingPi(): {
    pi: ExtensionAPI;
    getHandler: () => ((event: { payload: unknown }) => unknown) | undefined;
  } {
    let hookHandler: ((event: { payload: unknown }) => unknown) | undefined;
    const pi = {
      on(event: string, handler: (event: { payload: unknown }) => unknown) {
        if (event === "before_provider_request") hookHandler = handler;
      },
    } as unknown as ExtensionAPI;
    return { pi, getHandler: () => hookHandler };
  }

  function withSamplingEnv(params: string, fn: () => void): void {
    process.env["PI_SAMPLING_PARAMS"] = params;
    try {
      fn();
    } finally {
      delete process.env["PI_SAMPLING_PARAMS"];
    }
  }

  test("registers before_provider_request and patches when PI_SAMPLING_PARAMS is set", () => {
    withSamplingEnv(JSON.stringify({ temperature: 0.1 }), () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      const handler = getHandler();
      expect(handler).toBeDefined();
      const patched = handler?.({
        payload: { model: "claude-3", messages: [] },
      });
      expect(patched).toEqual({
        model: "claude-3",
        messages: [],
        temperature: 0.1,
      });
    });
  });

  test("does not register handler when PI_SAMPLING_PARAMS is not set", () => {
    const { pi, getHandler } = makeTrackingPi();
    defaultSamplingExtension(pi);
    expect(getHandler()).toBeUndefined();
  });

  test("does not register handler when PI_SAMPLING_PARAMS contains invalid JSON", () => {
    withSamplingEnv("{invalid}", () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      expect(getHandler()).toBeUndefined();
    });
  });

  test("does not mutate original payload in hook execution", () => {
    withSamplingEnv(JSON.stringify({ temperature: 0.1 }), () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      const handler = getHandler();
      expect(handler).toBeDefined();
      const payload = Object.freeze({
        model: "claude-3",
        messages: Object.freeze([]),
      });
      const patched = handler?.({ payload });
      expect(patched).toEqual({
        model: "claude-3",
        messages: [],
        temperature: 0.1,
      });
      expect(patched).not.toBe(payload);
    });
  });

  test("returns undefined for non-object payload", () => {
    withSamplingEnv(JSON.stringify({ temperature: 0.1 }), () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      const handler = getHandler();
      expect(handler).toBeDefined();
      expect(handler?.({ payload: null })).toBeUndefined();
      expect(handler?.({ payload: "string" })).toBeUndefined();
    });
  });

  test("returns undefined for array payload", () => {
    withSamplingEnv(JSON.stringify({ topP: 0.5 }), () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      const handler = getHandler();
      expect(handler).toBeDefined();
      expect(handler?.({ payload: [] })).toBeUndefined();
    });
  });
});

describe("Wire child-scoped sampling env and extension loading", () => {
  async function runCapturedAgentWithParams(
    agent: AgentConfig,
  ): Promise<{ args: string[]; envSampling: string; result: SingleResult }> {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' "$PI_SAMPLING_PARAMS" > env_sampling.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    });
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
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const envSampling = fs
      .readFileSync(path.join(cwd, "env_sampling.txt"), "utf8")
      .trim();
    return { args, envSampling, result };
  }

  function getExtensionPaths(args: string[]): string[] {
    return args.flatMap((arg, i) =>
      arg === "--extension" ? [args[i + 1] ?? ""] : [],
    );
  }

  function expectExtensions(args: string[], count: number): void {
    const extensions = getExtensionPaths(args);
    expect(extensions).toHaveLength(count);
    expect(extensions[0]).toContain("complete-extension");
    if (count > 1) expect(extensions[1]).toContain("sampling-extension");
  }

  test("sampling-enabled agent spawn includes correct environment variable and both complete and sampling extension args", async () => {
    const agent = makeModelAgent({
      name: "sampling-agent",
      temperature: 0.7,
      topP: 0.9,
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe('{"temperature":0.7,"topP":0.9}');
    expectExtensions(args, 2);
  });

  test("agent with temperature only includes only temperature in environment variable and loads sampling extension", async () => {
    const agent = makeModelAgent({
      name: "temp-only-agent",
      temperature: 0.3,
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe('{"temperature":0.3}');
    expectExtensions(args, 2);
  });

  test("agent with topP only includes only topP in environment variable and loads sampling extension", async () => {
    const agent = makeModelAgent({
      name: "topp-only-agent",
      topP: 0.25,
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe('{"topP":0.25}');
    expectExtensions(args, 2);
  });

  test("agent without sampling values omits sampling env and sampling extension args while still loading the complete extension", async () => {
    const agent = makeModelAgent({
      name: "no-sampling-agent",
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe("");
    expectExtensions(args, 1);
    expect(args.join(" ")).not.toContain("sampling-extension");
  });

  test("concurrent or sequential different agents do not leak sampling values across runs", async () => {
    const samplingAgent = makeModelAgent({
      name: "sampling-agent",
      temperature: 0.5,
    });
    const plainAgent = makeModelAgent({
      name: "plain-agent",
    });

    const run1 = await runCapturedAgentWithParams(samplingAgent);
    const run2 = await runCapturedAgentWithParams(plainAgent);

    expect(run1.envSampling).toBe('{"temperature":0.5}');
    expect(run2.envSampling).toBe("");
  });

  test("no-sampling agent removes inherited parent PI_SAMPLING_PARAMS from child env", async () => {
    process.env["PI_SAMPLING_PARAMS"] = '{"temperature":0.1}';
    try {
      const agent = makeModelAgent({
        name: "no-sampling-agent",
      });
      const { args, envSampling } = await runCapturedAgentWithParams(agent);
      expect(envSampling).toBe("");
      expect(args.join(" ")).not.toContain("sampling-extension");
    } finally {
      delete process.env["PI_SAMPLING_PARAMS"];
    }
  });

  test("concurrent mixed sampling and no-sampling runs are isolated and do not contaminate or leak", async () => {
    process.env["PI_SAMPLING_PARAMS"] = '{"temperature":0.8}';
    try {
      const samplingAgent = makeModelAgent({
        name: "sampling-agent",
        temperature: 0.4,
      });
      const noSamplingAgent = makeModelAgent({
        name: "no-sampling-agent",
      });
      const [run1, run2] = await Promise.all([
        runCapturedAgentWithParams(samplingAgent),
        runCapturedAgentWithParams(noSamplingAgent),
      ]);
      expect(run1.envSampling).toBe('{"temperature":0.4}');
      expect(run2.envSampling).toBe("");
    } finally {
      delete process.env["PI_SAMPLING_PARAMS"];
    }
  });
});

describe("resolveSamplingExtensionPath", () => {
  function withTempDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sampling-ext-"));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test.each([
    {
      name: "returns primary runtime extension when sampling-extension.ts exists",
      extensionFile: "sampling-extension.ts",
    },
    {
      name: "falls back to alternate extension when only sampling-extension.js exists",
      extensionFile: "sampling-extension.js",
    },
  ])("$name", (row) => {
    withTempDir((dir) => {
      const expected = path.join(dir, row.extensionFile);
      fs.writeFileSync(expected, "");
      const resolved = resolveSamplingExtensionPath(dir);
      expect(resolved).toBe(expected);
    });
  });

  test("throws when neither sampling-extension.ts nor sampling-extension.js exists", () => {
    withTempDir((dir) => {
      expect(() => resolveSamplingExtensionPath(dir)).toThrow(
        /sampling-extension not found/,
      );
    });
  });

  test("defaults to module directory and returns existing file", () => {
    const resolved = resolveSamplingExtensionPath();
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toMatch(/sampling-extension\.ts$/);
    expect(fs.existsSync(resolved)).toBe(true);
  });
});

describe("process cleanup", () => {
  test("runSingleAgent destroys idle streams when the child exits with an inherited open pipe", async () => {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
(sleep 0.5 &)
exit 0
`,
    });
    const startedAt = Date.now();
    const { result } = await runSingleAgent(
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
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
  });
});

test("runSingleAgent adds sampling extension when agent provides temperature or topP", async () => {
  const agent = makeModelAgent({ temperature: 0.5, topP: 0.9 });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  const extPaths = flagValues(args, "--extension");
  expect(extPaths.length).toBe(2);
  expect(extPaths.some((p) => p.includes("sampling-extension"))).toBe(true);
  expect(extPaths.some((p) => p.includes("complete-extension"))).toBe(true);
});

test("runSingleAgent emits unknown-event diagnostics when debugEventDiagnostics is enabled", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' 'not valid json'
printf '%s\\n' '{"type":"unknown_kind","payload":1}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const stderrChunks: string[] = [];
  const writeSpy = spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    const { result } = await runSingleAgent(
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
    const diagnostic = stderrChunks.join("");
    expect(diagnostic).toContain("[pi-subagent:unknown-event]");
    expect(diagnostic).toContain("malformed:");
    expect(diagnostic).toContain("unknown:");
  } finally {
    writeSpy.mockRestore();
  }
});

test("runSingleAgent strips leading Terminated lines from stderr on agent_end_timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'Terminated\\nother stderr\\n' >&2
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const { result } = await runSingleAgent(
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
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
  expect(result.stderr).not.toContain("Terminated");
  expect(result.stderr).toContain("other stderr");
});

test("runSingleAgent sets errorMessage when a toolResult error occurs without a complete outcome", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"bash","arguments":{"command":"false"}}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true,"content":[{"type":"text","text":"error"}]}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
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
  expect(result.outcome).toBeUndefined();
  expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
});

test("runSingleAgent preserves complete outcome when complete toolResult errors", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Completed despite error"}}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true,"details":{"outcome":"Completed despite error"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
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
  expect(result.outcome).toBe("Completed despite error");
  expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
});

test("runSingleAgent extracts complete outcome from agent_end snapshot despite toolResult error", async () => {
  const assistantMsg = makeAssistantMessage("used complete", {
    content: [
      {
        type: "toolCall",
        id: "tc-complete",
        name: "complete",
        arguments: { outcome: "Snapshot succeeded" },
      },
    ],
  });
  const toolError = {
    role: "toolResult",
    toolCallId: "tc-complete",
    isError: true,
    content: [{ type: "text", text: "complete toolResult error" }],
  } as Record<string, unknown>;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(assistantMsg)}
${emitAgentEnd([assistantMsg, toolError])}
exit 0
`,
  });
  const { result } = await runSingleAgent(
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
  expect(result.outcome).toBe("Snapshot succeeded");
  expect(result.messages).toHaveLength(2);
});

test("runSingleAgent rebuilds agent_end snapshot and propagates toolResult error", async () => {
  const assistant = makeAssistantMessage("used tool", {
    content: [
      {
        type: "toolCall",
        id: "tc-1",
        name: "bash",
        arguments: { command: "false" },
      },
    ],
  });
  const toolError = {
    role: "toolResult",
    toolCallId: "tc-1",
    isError: true,
    content: [{ type: "text", text: "error" }],
  } as Record<string, unknown>;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(assistant)}
${emitAgentEnd([assistant, toolError])}
exit 0
`,
  });
  const { result } = await runSingleAgent(
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
  expect(result.messages).toHaveLength(2);
  expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
  expect(result.outcome).toBeUndefined();
});

test("runSingleAgent succeeds when sleep inhibitor acquisition fails", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
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
      acquireSleepInhibitor: async () => {
        throw new Error("inhibitor unavailable");
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
});

test("discovery-normalized context true omits --no-context-files from child args", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const agentsDir = path.join(agentDir, "agents");
  await fs.promises.writeFile(
    path.join(agentsDir, "context-true.md"),
    `---
name: context-true
context: true
description: Context true agent
---
Prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const discoveredAgent = discovery.agents.find(
    (a) => a.name === "context-true",
  );
  if (!discoveredAgent) throw new Error("context-true agent not discovered");
  expect(Object.hasOwn(discoveredAgent, "context")).toBe(false);
  expect(discoveredAgent.context).toBeUndefined();
  const args = await captureRunSingleAgentArgs(discoveredAgent, undefined);
  expect(args).not.toContain("--no-context-files");
  expect(args).toContain("--approve");
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
    await waitFor(
      () => reloadStarted || undefined,
      "skill + extension discovery start",
    );
    await waitFor(() => writeStarted || undefined, "prompt write start");
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

test("runSingleAgent named extensions flow through to child args via runSingleAgent", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const resolvedPath = path.join(
    cwd,
    ".pi",
    "extensions",
    "my-ext",
    "index.js",
  );
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(resolvedPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
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
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["my-ext"],
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
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const pkgPath = resolvePackageExtensionPath();
    expect(args).toContain("--no-extensions");
    expect(flagValues(args, "--extension")).toContain(pkgPath);
    const resolvedExt = flagValues(args, "--extension").find(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(resolvedExt).toBeDefined();
    expect(resolvedExt).toContain("my-ext");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent single-file extension resolves by file stem and flows to child args", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const resolvedPath = path.join(cwd, ".pi", "extensions", "helper.ts");
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(
    resolvedPath,
    "export default function setup() {}",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/helper.ts",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/helper.ts",
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
    extensions: ["helper"],
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
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const pkgPath = resolvePackageExtensionPath();
    expect(args).toContain("--no-extensions");
    expect(flagValues(args, "--extension")).toContain(pkgPath);
    const resolvedExt = flagValues(args, "--extension").find(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(resolvedExt).toBeDefined();
    expect(resolvedExt).toContain("helper");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent version-pinned npm package extension resolves and flows to child args", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const resolvedPath = path.join(cwd, "node_modules", "helper", "index.js");
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(resolvedPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "node_modules/helper",
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
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["helper"],
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
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const pkgPath = resolvePackageExtensionPath();
    expect(args).toContain("--no-extensions");
    expect(flagValues(args, "--extension")).toContain(pkgPath);
    const resolvedExt = flagValues(args, "--extension").find(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(resolvedExt).toBeDefined();
    expect(resolvedExt).toContain("helper");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
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

test("RunSingleAgentResult discriminated union narrows on kind", () => {
  const completed: RunSingleAgentResult = {
    kind: "completed",
    result: makeSingleResult({ finalOutput: "done", outcome: "ok" }),
  };
  const aborted: RunSingleAgentResult = {
    kind: "aborted",
    result: makeSingleResult({ finalOutput: "", outcome: undefined }),
  };
  if (completed.kind === "completed") {
    expect(completed.result.outcome).toBe("ok");
  }
  if (aborted.kind === "aborted") {
    expect(aborted.result.outcome).toBeUndefined();
  }
});

test("aborted RunSingleAgentResult omits outcome and has empty stderr", () => {
  const aborted: RunSingleAgentResult = {
    kind: "aborted",
    result: makeSingleResult({
      finalOutput: "",
      outcome: undefined,
      stderr: "",
    }),
  };
  expect(aborted.result.stderr).toBe("");
  expect(aborted.result.outcome).toBeUndefined();
});

test("completed RunSingleAgentResult preserves outcome and stderr", () => {
  const completed: RunSingleAgentResult = {
    kind: "completed",
    result: makeSingleResult({
      finalOutput: "done",
      outcome: "task completed",
      stderr: "warning: deprecation",
    }),
  };
  expect(completed.result.outcome).toBe("task completed");
  expect(completed.result.stderr).toBe("warning: deprecation");
});

describe("hasCompletedAgentOutput", () => {
  test("returns true when finalOutput has non-whitespace content", () => {
    const result = makeRuntimeResult({
      finalOutput: "some output",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result)).toBe(true);
  });

  test("returns true when finalOutput is whitespace-only but outcome has content", () => {
    const result = makeRuntimeResult({
      finalOutput: "   \n  ",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result, "completed successfully")).toBe(
      true,
    );
  });

  test("returns true when both finalOutput and outcome are empty but messages contain final output text", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "real output" }],
        } as unknown as Message,
      ],
    });
    expect(hasCompletedAgentOutput(result)).toBe(true);
  });

  test("returns false when finalOutput is empty and outcome is undefined", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result)).toBe(false);
  });

  test("returns false when finalOutput is only whitespace and outcome is empty", () => {
    const result = makeRuntimeResult({
      finalOutput: "   ",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result, "   ")).toBe(false);
  });

  test("returns true when outcome has content regardless of finalOutput state", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result, "all done")).toBe(true);
  });

  test("returns false when messages exist but have no assistant text", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        } as unknown as Message,
      ],
    });
    expect(hasCompletedAgentOutput(result)).toBe(false);
  });
});

describe("getAgentEndTimeoutExitCode", () => {
  test("returns undefined when termination cancelReason is not agent_end_timeout", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "user_cancelled",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when termination is absent", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when spawnError is present", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    const spawnError = new Error("spawn failed");
    expect(
      getAgentEndTimeoutExitCode(result, spawnError, undefined),
    ).toBeUndefined();
  });

  test.each([
    { name: "returns undefined when stopReason is error", stopReason: "error" },
    {
      name: "returns undefined when stopReason is aborted",
      stopReason: "aborted",
    },
  ])("$name", (row) => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      stopReason: row.stopReason,
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when errorMessage has non-whitespace content", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      errorMessage: "something went wrong",
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns 1 when errorMessage is whitespace-only and no output", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      errorMessage: "   ",
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(1);
  });

  test.each([
    {
      name: "returns 0 when agent completed output and agent_end_timeout",
      finalOutput: "task completed",
      expectedExitCode: 0,
    },
    {
      name: "returns 1 when agent did not complete output and agent_end_timeout",
      finalOutput: "",
      expectedExitCode: 1,
    },
  ])("$name", (row) => {
    const result = makeRuntimeResult({
      finalOutput: row.finalOutput,
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(
      row.expectedExitCode,
    );
  });

  test("returns 0 when outcome provides content for agent_end_timeout", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, "done")).toBe(0);
  });

  test("returns 0 when messages contain output for agent_end_timeout with no finalOutput", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "result text" }],
        } as unknown as Message,
      ],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(0);
  });
});
