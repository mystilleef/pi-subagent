/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  skills?: string[];
  thinking?: ThinkingLevel;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

function mergeAgentLists(
  userAgents: AgentConfig[],
  projectAgents: AgentConfig[],
  projectAgentsDir: string | null,
): AgentDiscoveryResult {
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);
  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

function parseCommaList(raw: unknown): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseThinkingLevel(raw: unknown): ThinkingLevel | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as ThinkingLevel)
    : undefined;
}

function parseAgentConfig(
  content: string,
  source: "user" | "project",
  filePath: string,
): AgentConfig | null {
  let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch {
    return null;
  }
  const { frontmatter, body } = parsed;
  if (
    typeof frontmatter !== "object" ||
    frontmatter === null ||
    Array.isArray(frontmatter)
  )
    return null;
  const {
    name,
    description,
    tools: rawTools,
    skills: rawSkills,
    thinking: rawThinking,
  } = frontmatter;
  if (typeof name !== "string" || typeof description !== "string") return null;
  if (rawTools != null && typeof rawTools !== "string") return null;
  if (rawSkills != null && typeof rawSkills !== "string") return null;
  if (rawThinking != null && typeof rawThinking !== "string") return null;
  const tools = parseCommaList(rawTools);
  const skills = Object.hasOwn(frontmatter, "skills")
    ? (parseCommaList(rawSkills) ?? [])
    : undefined;
  const thinking = parseThinkingLevel(rawThinking);
  return {
    name,
    description,
    tools,
    skills,
    thinking,
    systemPrompt: body,
    source,
    filePath,
  };
}

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!fs.existsSync(dir)) {
    return agents;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const agent = parseAgentConfig(content, source, filePath);
    if (agent) agents.push(agent);
  }
  return agents;
}

async function loadAgentsFromDirAsync(
  dir: string,
  source: "user" | "project",
): Promise<AgentConfig[]> {
  const agents: AgentConfig[] = [];
  if (!(await isDirectoryAsync(dir))) return agents;
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = await fsPromises.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const agent = parseAgentConfig(content, source, filePath);
    if (agent) agents.push(agent);
  }
  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function isDirectoryAsync(p: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

async function findNearestProjectAgentsDirAsync(
  cwd: string,
): Promise<string | null> {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (await isDirectoryAsync(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope,
): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const userAgents =
    scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir
      ? []
      : loadAgentsFromDir(projectAgentsDir, "project");
  return mergeAgentLists(userAgents, projectAgents, projectAgentsDir);
}

export async function discoverAgentsAsync(
  cwd: string,
  scope: AgentScope,
): Promise<AgentDiscoveryResult> {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = await findNearestProjectAgentsDirAsync(cwd);
  const [userAgents, projectAgents] = await Promise.all([
    scope === "project" ? [] : loadAgentsFromDirAsync(userDir, "user"),
    scope === "user" || !projectAgentsDir
      ? []
      : loadAgentsFromDirAsync(projectAgentsDir, "project"),
  ]);
  return mergeAgentLists(userAgents, projectAgents, projectAgentsDir);
}

export function formatAgentList(
  agents: AgentConfig[],
  maxItems: number,
): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed
      .map((a) => `${a.name} (${a.source}): ${a.description}`)
      .join("; "),
    remaining,
  };
}
