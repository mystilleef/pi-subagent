import { describe, expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { getCachedAgentDiscovery } from "../src/agent/agent-cache.js";
import {
  CAPTURE_PI_ARGS_SH,
  installFakePi,
  makeAgentHome,
  makeTempDir,
  readCapturedArgs,
  setupFakePi,
  setupHooks,
  waitFor,
  waitForPath,
} from "./helpers.js";

const hooks = setupHooks();

const PRISTINE_ARGV_1 = process.argv[1] ?? "";
const PRISTINE_PATH = process.env.PATH;
const PRISTINE_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const PRISTINE_AGENT_END_GRACE_MS = process.env.PI_SUBAGENT_AGENT_END_GRACE_MS;

type CaseState = {
  root: string;
  registered: string;
  cwd: string;
  primed: Awaited<ReturnType<typeof getCachedAgentDiscovery>>;
};

let caseState: CaseState | undefined;

function findExecutables(root: string): string[] {
  const executables: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if ((fs.statSync(entryPath).mode & 0o111) !== 0) {
        executables.push(entryPath);
      }
    }
  };
  visit(root);
  return executables;
}

function expectEnvRestored(key: string, pristine: string | undefined): void {
  expect(process.env[key]).toBe(pristine);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawns a fake `pi` the way child runtime does—as a detached process-group
 * leader—without attaching any owner in the case body.
 */
function spawnUnownedFakePi(binDir: string, cwd: string): number {
  const child = spawn(path.join(binDir, "pi"), [], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (child.pid === undefined) throw new Error("fake pi did not start");
  return child.pid;
}

describe("makeAgentHome", () => {
  test("creates discovery home with fixture agent and no fake executable", async () => {
    const { agentDir, cwd } = await makeAgentHome();
    const root = path.dirname(agentDir);
    expect(fs.statSync(agentDir).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(agentDir, "agents")).isDirectory()).toBe(true);
    expect(fs.statSync(cwd).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(agentDir, "agents"))).toEqual(["hang.md"]);
    expect(fs.readdirSync(root).sort()).toEqual(["agent", "work"]);
    expect(findExecutables(root)).toEqual([]);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
  });
});

describe("setupHooks per-case restoration", () => {
  test("case fixtures may mutate shared globals, prime caches, and register trees", async () => {
    const home = await makeAgentHome();
    const registered = await makeTempDir("pi-subagent-helper-registered-");
    process.argv[1] = path.join(registered, "not-pi");
    process.env.PATH = `${registered}:${PRISTINE_PATH ?? ""}`;
    process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "1234";
    const primed = await getCachedAgentDiscovery(home.cwd, "user");
    caseState = {
      root: path.dirname(home.agentDir),
      registered,
      cwd: home.cwd,
      primed,
    };
    expect(process.argv[1]).toBe(path.join(registered, "not-pi"));
    expect(process.env.PI_CODING_AGENT_DIR).toBe(home.agentDir);
    expect(process.env.PI_SUBAGENT_AGENT_END_GRACE_MS).toBe("1234");
    expect(primed.agents.some((agent) => agent.name === "hang")).toBe(true);
  });

  test("teardown restores shared globals, resets caches, and removes registered trees", async () => {
    expect(process.argv[1]).toBe(PRISTINE_ARGV_1);
    expect(process.env.PATH).toBe(PRISTINE_PATH);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(PRISTINE_AGENT_DIR);
    expect(process.env.PI_SUBAGENT_AGENT_END_GRACE_MS).toBe(
      PRISTINE_AGENT_END_GRACE_MS,
    );
    const prior = caseState;
    if (prior !== undefined) {
      expect(fs.existsSync(prior.root)).toBe(false);
      expect(fs.existsSync(prior.registered)).toBe(false);
      const afterReset = await getCachedAgentDiscovery(prior.cwd, "user");
      expect(afterReset).not.toBe(prior.primed);
      expect(afterReset.agents).toEqual([]);
    }
    // Order-independent proof: register fixtures inside this case and run the
    // same teardown the `afterEach` hook registers, so standalone or shuffled
    // selection still exercises cleanup and cache assertions.
    const home = await makeAgentHome();
    const registered = await makeTempDir("pi-subagent-helper-registered-");
    const primed = await getCachedAgentDiscovery(home.cwd, "user");
    const root = path.dirname(home.agentDir);
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(registered)).toBe(true);
    expect(primed.agents.some((agent) => agent.name === "hang")).toBe(true);
    process.argv[1] = path.join(registered, "not-pi");
    process.env.PATH = `${registered}${path.delimiter}${PRISTINE_PATH ?? ""}`;
    process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "4321";
    expect(process.argv[1]).toBe(path.join(registered, "not-pi"));
    expect(process.env.PATH).not.toBe(PRISTINE_PATH);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(home.agentDir);
    expect(process.env.PI_SUBAGENT_AGENT_END_GRACE_MS).not.toBe(
      PRISTINE_AGENT_END_GRACE_MS,
    );
    await hooks.teardown();
    expect(process.argv[1]).toBe(PRISTINE_ARGV_1);
    expectEnvRestored("PATH", PRISTINE_PATH);
    expectEnvRestored("PI_CODING_AGENT_DIR", PRISTINE_AGENT_DIR);
    expectEnvRestored(
      "PI_SUBAGENT_AGENT_END_GRACE_MS",
      PRISTINE_AGENT_END_GRACE_MS,
    );
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(registered)).toBe(false);
    const afterReset = await getCachedAgentDiscovery(home.cwd, "user");
    expect(afterReset).not.toBe(primed);
    expect(afterReset.agents).toEqual([]);
    caseState = undefined;
  });
});

describe("fixture child process ownership", () => {
  test("teardown terminates a fake pi that a failed case never cancels", async () => {
    const { binDir, cwd } = await setupFakePi();
    await installFakePi(
      binDir,
      `#!/bin/sh
sleep 30 &
printf '%s\n' $! > sleeper.pid
wait $!
`,
    );
    const childPid = spawnUnownedFakePi(binDir, cwd);
    const sleeperMarker = path.join(cwd, "sleeper.pid");
    await waitForPath(sleeperMarker, "fake pi descendant pid marker");
    // The marker appears on redirection before the shell writes the pid;
    // synchronize on written content rather than mere existence.
    const sleeperPid = await waitFor(() => {
      let text: string;
      try {
        text = fs.readFileSync(sleeperMarker, "utf8");
      } catch {
        return undefined;
      }
      const pid = Number.parseInt(text.trim(), 10);
      return Number.isSafeInteger(pid) ? pid : undefined;
    }, "fake pi descendant pid").catch(() => undefined);
    if (sleeperPid === undefined) {
      throw new Error("fake pi descendant pid missing");
    }
    expect(isProcessRunning(childPid)).toBe(true);
    expect(isProcessRunning(sleeperPid)).toBe(true);
    await hooks.teardown();
    expect(isProcessRunning(childPid)).toBe(false);
    expect(isProcessRunning(sleeperPid)).toBe(false);
  });

  test("teardown tolerates a fake pi that already exited", async () => {
    const { binDir, cwd } = await setupFakePi();
    const child = spawn(path.join(binDir, "pi"), [], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    if (child.pid === undefined) throw new Error("fake pi did not start");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(isProcessRunning(child.pid)).toBe(false);
    await expect(hooks.teardown()).resolves.toBeUndefined();
    expect(fs.existsSync(binDir)).toBe(false);
  });
});

async function runCaptureScript(
  cwd: string,
  argv: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "sh",
      ["-c", CAPTURE_PI_ARGS_SH, "sh", ...argv],
      { cwd },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });
}

const CAPTURE_CASES: Array<{ name: string; argv: string[] }> = [
  { name: "captures zero arguments as an empty argv", argv: [] },
  {
    name: "captures one empty argument as one empty element",
    argv: [""],
  },
  {
    name: "round-trips multiline and empty argument boundaries",
    argv: ["--append-system-prompt", "line one\nline two", "", "a b"],
  },
];

describe("CAPTURE_PI_ARGS_SH", () => {
  test.each(CAPTURE_CASES)("$name", async ({ argv }) => {
    const cwd = await makeTempDir("pi-subagent-capture-");
    await runCaptureScript(cwd, argv);
    expect(await readCapturedArgs(cwd)).toEqual(argv);
  });
});

describe("preload agent home exit cleanup", () => {
  test("child serial run empties fresh TMPDIR including hidden trees despite failing assertion", async () => {
    const probeRoot = await makeTempDir("pi-subagent-preload-probe-");
    const childTmp = await makeTempDir("pi-subagent-preload-tmp-");
    try {
      const probeFile = path.join(probeRoot, "probe.test.ts");
      const helpersPath = path.join(import.meta.dir, "helpers.js");
      const preloadPath = path.join(import.meta.dir, "preload.ts");
      fs.writeFileSync(
        probeFile,
        `import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeAgentHome, makeTempDir, setupHooks } from ${JSON.stringify(helpersPath)};

setupHooks();

test("probe pass case registers fixtures", async () => {
  const tmpRoot = process.env.TMPDIR;
  if (!tmpRoot) throw new Error("probe TMPDIR missing");
  const { agentDir, cwd } = await makeAgentHome();
  await makeTempDir("pi-subagent-probe-pass-");
  await makeTempDir(".pi-subagent-probe-hidden-");
  writeFileSync(join(agentDir, ".hidden-probe"), "hidden");
  expect(agentDir.startsWith(tmpRoot)).toBe(true);
  expect(cwd.startsWith(tmpRoot)).toBe(true);
});

test("probe fail case exercises cleanup on assertion failure", async () => {
  const { agentDir } = await makeAgentHome();
  await makeTempDir("pi-subagent-probe-fail-");
  await makeTempDir(".pi-subagent-probe-hidden-fail-");
  writeFileSync(join(agentDir, ".hidden-fail"), "hidden");
  expect("leaked").toBe("clean");
});
`,
      );
      const { exitCode, output } = await new Promise<{
        exitCode: number;
        output: string;
      }>((resolve) => {
        execFile(
          process.execPath,
          ["test", "--preload", preloadPath, probeFile],
          {
            cwd: probeRoot,
            env: {
              ...process.env,
              TMPDIR: childTmp,
              CI: "true",
              NO_COLOR: "1",
              PAGER: "cat",
              TERM: "dumb",
            },
            timeout: 25_000,
            maxBuffer: 4 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            resolve({
              exitCode: typeof error?.code === "number" ? error.code : 0,
              output: `${stdout}${stderr}`,
            });
          },
        );
      });
      expect(exitCode).not.toBe(0);
      expect(output).toContain("probe fail case exercises cleanup");
      expect(output).toContain("1 pass");
      expect(output).toContain("1 fail");
      expect(fs.readdirSync(childTmp)).toEqual([]);
    } finally {
      await fs.promises.rm(probeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
