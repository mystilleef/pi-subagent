import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { SingleResult } from "./types.js";

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

const SKILL_DISCOVERY_CACHE_TTL_MS = 300_000;

type ResolvedSkillArgsCacheEntry = {
  skillPaths: Map<string, string>;
  ts: number;
};

const resolvedSkillArgsCache = new Map<string, ResolvedSkillArgsCacheEntry>();

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    /* symlinks or missing paths fall back to absolute path resolution */
    return path.resolve(filePath);
  }
}

function buildSkillArgs(
  requested: string[],
  skillPaths: Map<string, string>,
): string[] {
  return requested.flatMap((name) => ["--skill", skillPaths.get(name) ?? name]);
}

export function resetResolvedAgentSkillArgsCache(): void {
  resolvedSkillArgsCache.clear();
}

export async function resolveAgentSkillArgs(
  cwd: string,
  skillNames: string[],
): Promise<{ args: string[] } | { error: string }> {
  const requested = Array.from(new Set(skillNames));
  if (requested.length === 0) return { args: [] };
  const cacheIdentitySkills = [...requested].sort();
  const agentDir = getAgentDir();
  const cacheKey = JSON.stringify({
    cwd: await canonicalPath(cwd),
    agentDir: await canonicalPath(agentDir),
    skills: cacheIdentitySkills,
  });
  const cached = resolvedSkillArgsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts <= SKILL_DISCOVERY_CACHE_TTL_MS) {
    return { args: buildSkillArgs(requested, cached.skillPaths) };
  }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  try {
    await loader.reload();
  } catch (error) {
    return {
      error: `Failed to discover skills: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { skills } = loader.getSkills();
  const skillMap = new Map(skills.map((skill) => [skill.name, skill]));
  const missing = requested.filter((name) => !skillMap.has(name));
  if (missing.length > 0) {
    const available =
      skills
        .map((skill) => skill.name)
        .sort()
        .join(", ") || "none";
    return {
      error: `Unknown skill${missing.length === 1 ? "" : "s"}: ${missing
        .map((name) => `"${name}"`)
        .join(", ")}. Available skills: ${available}.`,
    };
  }
  const skillPaths = new Map(
    requested.map((name) => [name, skillMap.get(name)?.filePath ?? name]),
  );
  const args = buildSkillArgs(requested, skillPaths);
  resolvedSkillArgsCache.set(cacheKey, { skillPaths, ts: Date.now() });
  return { args };
}

export function getSubagentDepth(): number {
  const d = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  if (!Number.isFinite(d) || d < 0) return 0;
  return Math.floor(d);
}

export function subagentDepthEnv(): Record<string, string> {
  return { PI_SUBAGENT_DEPTH: String(getSubagentDepth() + 1) };
}

export function findLastAssistantTextMessage(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg?.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (c) =>
          c.type === "text" &&
          typeof c.text === "string" &&
          c.text.trim().length > 0,
      )
    ) {
      return i;
    }
  }
  return -1;
}

export function extractFinalOutputFromMessages(messages: Message[]): string {
  const lastAsstIdx = findLastAssistantTextMessage(messages);
  if (lastAsstIdx < 0) return "";
  const content = messages[lastAsstIdx]?.content;
  if (!Array.isArray(content)) return "";
  const lastText = content.findLast((p) => p.type === "text");
  return lastText?.type === "text" ? (lastText.text ?? "") : "";
}

export function detectMessageError(messages: Message[]): boolean {
  const lastAssistantIdx = findLastAssistantTextMessage(messages);
  const from = lastAssistantIdx >= 0 ? lastAssistantIdx + 1 : 0;
  for (let i = messages.length - 1; i >= from; i--) {
    const msg = messages[i];
    if (msg?.role === "toolResult" && msg.isError) return true;
  }
  return false;
}

export function hasSubagentFailed(result: SingleResult): boolean {
  if (result.outcome?.trim()) return false;
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    Boolean(result.errorMessage?.trim()) ||
    detectMessageError(result.messages ?? [])
  );
}
