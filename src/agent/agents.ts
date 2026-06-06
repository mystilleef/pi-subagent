import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "user" | "project";
export type AgentScope = AgentSource | "both";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[] | undefined;
  skills?: string[] | undefined;
  thinking?: ThinkingLevel | undefined;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryScopeResult {
  agents: AgentConfig[];
  markdownFiles: string[];
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  scopes: Record<AgentSource, AgentDiscoveryScopeResult>;
}

function mergeAgentLists(
  userResult: AgentDiscoveryScopeResult,
  projectResult: AgentDiscoveryScopeResult,
  projectAgentsDir: string | null,
): AgentDiscoveryResult {
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of userResult.agents) agentMap.set(agent.name, agent);
  for (const agent of projectResult.agents) agentMap.set(agent.name, agent);
  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
    scopes: {
      user: userResult,
      project: projectResult,
    },
  };
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
  source: AgentSource,
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

async function loadAgentEntryAsync(
  dir: string,
  entryName: string,
  source: AgentSource,
): Promise<AgentConfig | null> {
  const filePath = path.join(dir, entryName);
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  return parseAgentConfig(content, source, filePath);
}

export function emptyScopeResult(): AgentDiscoveryScopeResult {
  return { agents: [], markdownFiles: [] };
}

async function loadAgentsFromDirAsync(
  dir: string,
  source: AgentSource,
): Promise<AgentDiscoveryScopeResult> {
  const markdownEntries = (await readMarkdownDirWithStatusAsync(dir)).entries;
  const markdownFiles = markdownEntries.map((entry) => entry.name);
  const parsedAgents = await Promise.all(
    markdownEntries.map((entry) =>
      loadAgentEntryAsync(dir, entry.name, source),
    ),
  );
  const agents = parsedAgents.filter(
    (agent): agent is AgentConfig => agent !== null,
  );
  return { agents, markdownFiles };
}

export function isMarkdownDirent(entry: Dirent): boolean {
  return (
    entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())
  );
}

export interface MarkdownDirListing {
  entries: Dirent[];
  ok: boolean;
}

export async function readMarkdownDirWithStatusAsync(
  dir: string | null,
): Promise<MarkdownDirListing> {
  if (!dir) return { entries: [], ok: true };
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    return { entries: entries.filter(isMarkdownDirent), ok: true };
  } catch {
    return { entries: [], ok: false };
  }
}

export function getUserAgentsDir(): string {
  return path.join(getAgentDir(), "agents");
}

export async function isDirectoryAsync(p: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(p)).isDirectory();
  } catch {
    return false;
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

export async function discoverAgentsAsync(
  cwd: string,
  scope: AgentScope,
): Promise<AgentDiscoveryResult> {
  const userDir = getUserAgentsDir();
  const projectAgentsDir = await findNearestProjectAgentsDirAsync(cwd);
  const [userDiscovery, projectDiscovery] = await Promise.all([
    scope === "project"
      ? emptyScopeResult()
      : loadAgentsFromDirAsync(userDir, "user"),
    scope === "user" || !projectAgentsDir
      ? emptyScopeResult()
      : loadAgentsFromDirAsync(projectAgentsDir, "project"),
  ]);
  return mergeAgentLists(userDiscovery, projectDiscovery, projectAgentsDir);
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
