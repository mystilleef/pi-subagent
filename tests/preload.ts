import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(
  path.join(tmpdir(), "pi-subagent-test-"),
);
