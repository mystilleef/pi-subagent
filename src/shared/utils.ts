/**
 * Barrel export for shared utilities.
 * Re-exports from focused modules; retains standalone utilities here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Re-export all public symbols from focused modules
export {
  DEFAULT_AGENT_END_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_OUTPUT_LINES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  getSubagentOutputLimits,
  getSubagentRuntimeLimits,
  truncateOutput,
} from "./limits.js";
export {
  detectMessageError,
  extractFinalOutputFromMessages,
  findLastAssistantTextMessage,
  hasSubagentFailed,
} from "./message-utils.js";
export {
  EXTENSION_DISCOVERY_CACHE_TTL_MS,
  resetResolvedAgentExtensionPathsCache,
  resetResolvedAgentSkillArgsCache,
  resolveAgentExtensionPaths,
  resolveAgentSkillArgs,
} from "./resource-resolution.js";

// Standalone utilities retained in this module

export async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-"),
  );
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  // mkdtemp guarantees a unique directory per call; no concurrent writer can hold this path.
  await fs.promises.writeFile(filePath, prompt, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return { dir: tmpDir, filePath };
}

export function getPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

export function getSubagentDepth(): number {
  const d = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  if (!Number.isFinite(d) || d < 0) return 0;
  return Math.floor(d);
}

export function subagentDepthEnv(): Record<string, string> {
  return { PI_SUBAGENT_DEPTH: String(getSubagentDepth() + 1) };
}
