import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Keep dependency transpile caches out of the isolated test temp root.
process.env.JITI_FS_CACHE = "false";

// Tests never deliver real desktop notifications; cases that exercise
// delivery opt in with `withEnv` and fake spawn dependencies.
process.env.PI_SUBAGENT_DESKTOP_NOTIFICATIONS = "0";

const agentHome = mkdtempSync(path.join(tmpdir(), "pi-subagent-test-"));

process.env.PI_CODING_AGENT_DIR = agentHome;

// Synchronous removal keeps the home out of temp roots even when assertions
// fail or asynchronous work is still pending at run or process end.
const removeAgentHome = (): void => {
  rmSync(agentHome, { recursive: true, force: true });
};

afterAll(removeAgentHome);
process.on("exit", removeAgentHome);
