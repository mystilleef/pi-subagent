/**
 * Output and runtime limit configuration for subagent processes.
 * Handles byte/line caps for child output and runtime safety thresholds.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 50_000;
export const DEFAULT_MAX_OUTPUT_LINES = 500;
export const DEFAULT_AGENT_END_GRACE_MS = 250;
export const DEFAULT_MAX_STDERR_BYTES = 10_000;
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
const MAX_SUBAGENT_DEPTH_CEILING = 10;

export interface SubagentOutputLimits {
  maxBytes: number;
  maxLines: number;
}

export interface SubagentRuntimeLimits {
  agentEndGraceMs: number;
  maxStderrBytes: number;
  maxDepth: number;
}

type EnvLimitConfig = Partial<Record<string, string | number | undefined>>;

function parsePositiveInteger(
  value: string | number | undefined,
): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1)
    return undefined;
  return parsed;
}

export function getSubagentOutputLimits(
  config: EnvLimitConfig = process.env,
): SubagentOutputLimits {
  return {
    maxBytes:
      parsePositiveInteger(config["PI_SUBAGENT_MAX_OUTPUT_BYTES"]) ??
      DEFAULT_MAX_OUTPUT_BYTES,
    maxLines:
      parsePositiveInteger(config["PI_SUBAGENT_MAX_OUTPUT_LINES"]) ??
      DEFAULT_MAX_OUTPUT_LINES,
  };
}

export function getSubagentRuntimeLimits(
  config: EnvLimitConfig = process.env,
): SubagentRuntimeLimits {
  const maxDepth =
    parsePositiveInteger(config["PI_SUBAGENT_MAX_DEPTH"]) ??
    DEFAULT_MAX_SUBAGENT_DEPTH;
  return {
    agentEndGraceMs:
      parsePositiveInteger(config["PI_SUBAGENT_AGENT_END_GRACE_MS"]) ??
      DEFAULT_AGENT_END_GRACE_MS,
    maxStderrBytes:
      parsePositiveInteger(config["PI_SUBAGENT_MAX_STDERR_BYTES"]) ??
      DEFAULT_MAX_STDERR_BYTES,
    maxDepth: Math.min(maxDepth, MAX_SUBAGENT_DEPTH_CEILING),
  };
}

export function truncateOutput(
  text: string,
  limits: SubagentOutputLimits = getSubagentOutputLimits(),
): string {
  const lines = text.split("\n");
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes));
  const maxLines = Math.max(1, Math.floor(limits.maxLines));
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes)
    return text;
  let result = lines.slice(0, maxLines).join("\n");
  if (Buffer.byteLength(result, "utf-8") > maxBytes) {
    const buf = Buffer.from(result).subarray(0, maxBytes);
    result = buf.toString("utf-8").replace(/\uFFFD$/, "");
  }
  const kept = result.split("\n").length;
  return `[TRUNCATED: first ${kept} of ${lines.length} lines]\n${result}`;
}
