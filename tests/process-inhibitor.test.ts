import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import {
  resetDefaultSleepInhibitorAcquirer,
  runSingleAgent,
  setDefaultSleepInhibitorAcquirer,
} from "../src/child/process.js";
import * as terminationModule from "../src/child/termination.js";
import {
  createAgentEndTimeoutScenarioRunner,
  emitAgentEnd,
  emitMessageEnd,
  hangAgent,
  makeAssistantMessage,
  makeSubagentDetails,
  setupHooks,
  setupTest,
} from "./helpers.js";

setupHooks();

test("runSingleAgent routes sleep inhibitor acquisition to the orchestrator PID", async () => {
  const acquired: number[] = [];
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'child pid %s' "$$" >&2
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
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
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
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
${emitMessageEnd(makeAssistantMessage("delayed done"))}
${emitAgentEnd([])}
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
  const acquisitionStarted = Promise.withResolvers<void>();
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
        acquisitionStarted.resolve();
        return new Promise(() => {});
      },
    },
  );
  await acquisitionStarted.promise;
  controller.abort("host abort while acquiring");
  const outcome = await promise;
  expect(outcome.kind).toBe("aborted");
  expect(outcome.result.termination?.cancelReason).toBe(
    "host abort while acquiring",
  );
});

test("runSingleAgent releases injected sleep inhibitor after cancellation", async () => {
  let releases = 0;
  const acquisitionStarted = Promise.withResolvers<void>();
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
        acquisitionStarted.resolve();
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  await acquisitionStarted.promise;
  controller.abort("cancelled");
  const cancelledOutcome = await promise;
  expect(cancelledOutcome.kind).toBe("aborted");
  expect(cancelledOutcome.result.termination?.cancelReason).toBe("cancelled");
  expect(cancelledOutcome.result.stderr).toBe("");
  expect(releases).toBe(1);
});

const runAgentEndTimeoutScenario = createAgentEndTimeoutScenarioRunner();

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
  let resolveRelease!: () => void;
  const releaseBarrier = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
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
            resolveRelease();
          },
        };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  resolveAcquisition();
  await releaseBarrier;
  expect(releaseLog).toEqual(["released"]);
});

test("runSingleAgent suppresses unhandled rejection from late-acquired release failure", async () => {
  const unhandledRejections: unknown[] = [];
  let releaseAttempts = 0;
  const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let resolveAcquisition!: () => void;
  const acquisitionBarrier = new Promise<void>((resolve) => {
    resolveAcquisition = resolve;
  });
  let resolveReleaseAttempt!: () => void;
  const releaseAttemptBarrier = new Promise<void>((resolve) => {
    resolveReleaseAttempt = resolve;
  });
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
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
              releaseAttempts += 1;
              resolveReleaseAttempt();
              throw new Error("late release failure");
            },
          };
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    resolveAcquisition();
    await releaseAttemptBarrier;
    // Yield one macrotask turn so an escaped rejection surfaces in this case
    // before the assertion; the release attempt itself is already observed.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(releaseAttempts).toBe(1);
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
  const cancelledAcquired = Promise.withResolvers<void>();
  const heldAcquired = Promise.withResolvers<void>();
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
case "$*" in
  *cancelled-child*) trap 'exit 0' TERM; sleep 10 & wait $! ;;
  *held-child*) while [ ! -f release-held ]; do sleep 0.01; done; ${emitMessageEnd(makeAssistantMessage("held done", { usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } } }))}; ${emitAgentEnd([])}; exit 0 ;;
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
        cancelledAcquired.resolve();
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
        heldAcquired.resolve();
        return {
          async release() {
            releaseCounts.held += 1;
          },
        };
      },
    },
  );
  const releaseHeld = () =>
    fs.promises.writeFile(path.join(cwd, releasePath), "release");
  try {
    await Promise.all([cancelledAcquired.promise, heldAcquired.promise]);
    controller.abort("cancelled child only");
    const cancelledOutcome2 = await cancelledPromise;
    expect(cancelledOutcome2.kind).toBe("aborted");
    expect(releaseCounts.cancelled).toBe(1);
    expect(releaseCounts.held).toBe(0);
    await releaseHeld();
    const heldResult = await heldPromise;
    expect(heldResult.kind).toBe("completed");
    expect(heldResult.result.exitCode).toBe(0);
    expect(heldResult.result.finalOutput).toBe("held done");
    expect(heldResult.result.stderr).toBe("");
    expect(heldResult.result.usage.input).toBe(2);
    expect(heldResult.result.usage.output).toBe(3);
    expect(heldResult.result.termination).toBeUndefined();
    expect(releaseCounts.held).toBe(1);
  } finally {
    controller.abort("cancelled child only");
    await releaseHeld();
    await Promise.allSettled([cancelledPromise, heldPromise]);
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

test("runSingleAgent acquisition failure on one concurrent child does not affect the other", async () => {
  const releaseCounts = { failing: 0, succeeding: 0 };
  const failingAcquired = Promise.withResolvers<void>();
  const succeedingAcquired = Promise.withResolvers<void>();
  const releasePath = path.join("release-succeeding");
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
case "$*" in
  *failing-child*) exit 1 ;;
  *succeeding-child*) while [ ! -f release-succeeding ]; do sleep 0.01; done; ${emitMessageEnd(makeAssistantMessage("succeeding done", { usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } } }))}; ${emitAgentEnd([])}; exit 0 ;;
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
        failingAcquired.resolve();
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
        succeedingAcquired.resolve();
        return {
          async release() {
            releaseCounts.succeeding += 1;
          },
        };
      },
    },
  );
  await Promise.all([failingAcquired.promise, succeedingAcquired.promise]);
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

test("runSingleAgent succeeds when sleep inhibitor acquisition fails", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
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

describe("default sleep inhibitor acquirer seam", () => {
  test("harness default acquirer is a no-op that releases without host helpers", async () => {
    const { cwd } = await setupTest();
    // Harness beforeEach installs a no-op default; explicit undefined must
    // still complete with a valid orchestrator PID and no host spawn.
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      hangAgent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      false,
      {
        getOrchestratorPid: () => process.pid,
      },
    );
    expect(result.exitCode).toBe(0);
  });

  test("default acquirer is used when no explicit dependency is provided", async () => {
    const { cwd } = await setupTest();
    const acquired: number[] = [];
    const released: number[] = [];
    setDefaultSleepInhibitorAcquirer(async (pid) => {
      acquired.push(pid);
      return {
        async release() {
          released.push(pid);
        },
      };
    });
    try {
      const { result } = await runSingleAgent(
        cwd,
        [hangAgent],
        hangAgent.name,
        "task",
        undefined,
        undefined,
        makeSubagentDetails,
        undefined,
        "off",
        false,
        {
          getOrchestratorPid: () => 4242,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(acquired).toEqual([4242]);
    } finally {
      resetDefaultSleepInhibitorAcquirer();
    }
  });

  test("explicit per-call acquisition overrides the default acquirer", async () => {
    const { cwd } = await setupTest();
    const defaultAcquired: number[] = [];
    const explicitAcquired: number[] = [];
    setDefaultSleepInhibitorAcquirer(async (pid) => {
      defaultAcquired.push(pid);
      return {
        async release() {},
      };
    });
    try {
      const { result } = await runSingleAgent(
        cwd,
        [hangAgent],
        hangAgent.name,
        "task",
        undefined,
        undefined,
        makeSubagentDetails,
        undefined,
        "off",
        false,
        {
          getOrchestratorPid: () => 4343,
          acquireSleepInhibitor: async (pid) => {
            explicitAcquired.push(pid);
            return {
              async release() {},
            };
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(explicitAcquired).toEqual([4343]);
      expect(defaultAcquired).toEqual([]);
    } finally {
      resetDefaultSleepInhibitorAcquirer();
    }
  });

  test("reset restores the production acquirer without invoking host helpers", async () => {
    const { cwd } = await setupTest();
    const fakeAcquired: number[] = [];
    setDefaultSleepInhibitorAcquirer(async (pid) => {
      fakeAcquired.push(pid);
      return {
        async release() {},
      };
    });
    const productionAcquire = spyOn(
      terminationModule,
      "acquireChildSleepInhibitor",
    ).mockResolvedValue({
      async release() {},
    });
    resetDefaultSleepInhibitorAcquirer();
    // A valid orchestrator PID forces acquirer resolution, and spying on the
    // production acquirer's host-facing dependency keeps real helpers unspawned.
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      hangAgent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      false,
      {
        getOrchestratorPid: () => 4243,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(fakeAcquired).toEqual([]);
    expect(productionAcquire).toHaveBeenCalledWith(4243, {
      supported: expect.any(Function),
      acquire: expect.any(Function),
    });
  });
});
