import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { getCachedAgentDiscovery } from "../src/agent/agent-cache.js";
import { makeAgentHome, makeTempDir, setupHooks } from "./helpers.js";

setupHooks();

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
    const state = caseState;
    if (!state) return;
    expect(fs.existsSync(state.root)).toBe(false);
    expect(fs.existsSync(state.registered)).toBe(false);
    const afterReset = await getCachedAgentDiscovery(state.cwd, "user");
    expect(afterReset).not.toBe(state.primed);
    expect(afterReset.agents).toEqual([]);
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
