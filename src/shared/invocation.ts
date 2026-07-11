/**
 * Process invocation and subagent depth utilities.
 * Handles pi CLI discovery and recursion depth tracking via environment variables.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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
