import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import {
  type AgentDiscoveryResult,
  type AgentDiscoveryScopeResult,
  type AgentScope,
  type AgentSource,
  discoverAgentsAsync,
  emptyScopeResult,
  getUserAgentsDir,
  readMarkdownDirEntriesAsync,
} from "./agents.js";

interface AgentDiscoveryScopeSnapshot {
  markdownFiles: string[];
  fileHashes: Record<string, string | null>;
}

type AgentDiscoverySnapshots = Record<AgentSource, AgentDiscoveryScopeSnapshot>;

export type AgentDiscoveryCacheEntry = AgentDiscoveryResult & {
  ts: number;
  snapshots?: AgentDiscoverySnapshots;
};
export type AgentDiscoveryCache = Map<string, AgentDiscoveryCacheEntry>;
export const AGENT_DISCOVERY_CACHE_TTL_MS = 300_000;
const sharedAgentDiscoveryCache: AgentDiscoveryCache = new Map();
const AGENT_SOURCES = ["user", "project"] as const;

interface CacheOperationContext {
  cwd: string;
  cache: AgentDiscoveryCache;
  ts: number;
  cacheTtlMs: number;
}

export function resetAgentDiscoveryCache(): void {
  sharedAgentDiscoveryCache.clear();
}

function cacheKey(cwd: string, scope: AgentScope): string {
  return `${path.resolve(cwd)}\0${scope}`;
}

function getFreshCacheEntry(
  ctx: CacheOperationContext,
  key: string,
): AgentDiscoveryCacheEntry | undefined {
  const entry = ctx.cache.get(key);
  return entry && ctx.ts - entry.ts <= ctx.cacheTtlMs ? entry : undefined;
}

function emptySnapshot(): AgentDiscoveryScopeSnapshot {
  return { markdownFiles: [], fileHashes: {} };
}

function cloneScopeSnapshot(
  snapshot: AgentDiscoveryScopeSnapshot | undefined,
): AgentDiscoveryScopeSnapshot {
  if (!snapshot) return emptySnapshot();
  return {
    markdownFiles: [...snapshot.markdownFiles],
    fileHashes: { ...snapshot.fileHashes },
  };
}

function equalStringSets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

function snapshotsEqual(
  left: AgentDiscoveryScopeSnapshot,
  right: AgentDiscoveryScopeSnapshot,
): boolean {
  if (!equalStringSets(left.markdownFiles, right.markdownFiles)) return false;
  return left.markdownFiles.every(
    (fileName) => left.fileHashes[fileName] === right.fileHashes[fileName],
  );
}

function scopeAgentsMatchListing(
  scopeResult: AgentDiscoveryScopeResult,
  source: AgentSource,
  dir: string | null,
): boolean {
  if (!dir)
    return (
      scopeResult.agents.length === 0 && scopeResult.markdownFiles.length === 0
    );
  const listedFiles = new Set(scopeResult.markdownFiles);
  const resolvedDir = path.resolve(dir);
  return scopeResult.agents.every((agent) => {
    const fileName = path.basename(agent.filePath);
    return (
      agent.source === source &&
      listedFiles.has(fileName) &&
      path.resolve(path.dirname(agent.filePath)) === resolvedDir
    );
  });
}

async function hashMarkdownFileAsync(
  dir: string,
  fileName: string,
): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await fsPromises.readFile(path.join(dir, fileName)))
      .digest("hex");
  } catch {
    return null;
  }
}

async function buildScopeSnapshotAsync(
  dir: string | null,
): Promise<AgentDiscoveryScopeSnapshot> {
  if (!dir) return emptySnapshot();
  const entries = await readMarkdownDirEntriesAsync(dir);
  const markdownFiles = entries.map((entry) => entry.name);
  const hashPairs = await Promise.all(
    markdownFiles.map(
      async (fileName) =>
        [fileName, await hashMarkdownFileAsync(dir, fileName)] as const,
    ),
  );
  return { markdownFiles, fileHashes: Object.fromEntries(hashPairs) };
}

async function buildCacheSnapshotsAsync(
  discovery: AgentDiscoveryResult,
): Promise<AgentDiscoverySnapshots> {
  const [user, project] = await Promise.all([
    buildScopeSnapshotAsync(getUserAgentsDir()),
    buildScopeSnapshotAsync(discovery.projectAgentsDir),
  ]);
  return { user, project };
}

async function canTrustDerivedScopeAsync(
  source: AgentSource,
  bothEntry: AgentDiscoveryCacheEntry,
): Promise<boolean> {
  const dir =
    source === "user" ? getUserAgentsDir() : bothEntry.projectAgentsDir;
  const scopeResult = bothEntry.scopes[source];
  const cachedSnapshot = bothEntry.snapshots?.[source];
  if (!cachedSnapshot) return false;
  if (!scopeAgentsMatchListing(scopeResult, source, dir)) return false;
  if (!equalStringSets(scopeResult.markdownFiles, cachedSnapshot.markdownFiles))
    return false;
  return snapshotsEqual(cachedSnapshot, await buildScopeSnapshotAsync(dir));
}

function buildSourceRecord<T>(
  source: AgentSource,
  value: T,
  empty: () => T,
): Record<AgentSource, T> {
  const record: Record<AgentSource, T> = { user: empty(), project: empty() };
  record[source] = value;
  return record;
}
function createDerivedCacheEntry(
  bothEntry: AgentDiscoveryCacheEntry,
  source: AgentSource,
): AgentDiscoveryCacheEntry {
  const { agents, markdownFiles } = bothEntry.scopes[source];
  const clonedScope: AgentDiscoveryScopeResult = {
    agents: [...agents],
    markdownFiles: [...markdownFiles],
  };
  return {
    agents: clonedScope.agents,
    projectAgentsDir: bothEntry.projectAgentsDir,
    scopes: buildSourceRecord(source, clonedScope, emptyScopeResult),
    ts: bothEntry.ts,
    snapshots: buildSourceRecord(
      source,
      cloneScopeSnapshot(bothEntry.snapshots?.[source]),
      emptySnapshot,
    ),
  };
}

async function discoverAndCacheAsync(
  ctx: CacheOperationContext,
  scope: AgentScope,
): Promise<AgentDiscoveryCacheEntry> {
  const discovery = await discoverAgentsAsync(ctx.cwd, scope);
  const entry: AgentDiscoveryCacheEntry = {
    ...discovery,
    ts: ctx.ts,
    snapshots: await buildCacheSnapshotsAsync(discovery),
  };
  ctx.cache.set(cacheKey(ctx.cwd, scope), entry);
  if (scope === "both") {
    await primeScopedCacheEntriesAsync(ctx, entry);
  }
  return entry;
}

async function deriveOrDiscoverScopedEntryAsync(
  ctx: CacheOperationContext,
  source: AgentSource,
  bothEntry: AgentDiscoveryCacheEntry,
): Promise<AgentDiscoveryCacheEntry> {
  if (await canTrustDerivedScopeAsync(source, bothEntry)) {
    const entry = createDerivedCacheEntry(bothEntry, source);
    ctx.cache.set(cacheKey(ctx.cwd, source), entry);
    return entry;
  }
  return discoverAndCacheAsync(ctx, source);
}

async function primeScopedCacheEntriesAsync(
  ctx: CacheOperationContext,
  bothEntry: AgentDiscoveryCacheEntry,
): Promise<void> {
  for (const source of AGENT_SOURCES) {
    const scopedKey = cacheKey(ctx.cwd, source);
    if (getFreshCacheEntry(ctx, scopedKey)) continue;
    await deriveOrDiscoverScopedEntryAsync(ctx, source, bothEntry);
  }
}

export async function getCachedAgentDiscovery(
  cwd: string,
  scope: AgentScope,
  cache: AgentDiscoveryCache = sharedAgentDiscoveryCache,
  cacheTtlMs = AGENT_DISCOVERY_CACHE_TTL_MS,
): Promise<AgentDiscoveryCacheEntry> {
  const ctx: CacheOperationContext = { cwd, cache, ts: Date.now(), cacheTtlMs };
  const key = cacheKey(cwd, scope);
  const entry = getFreshCacheEntry(ctx, key);
  if (entry) return entry;
  if (scope !== "both") {
    const bothEntry = getFreshCacheEntry(ctx, cacheKey(cwd, "both"));
    if (bothEntry) {
      return deriveOrDiscoverScopedEntryAsync(ctx, scope, bothEntry);
    }
  }
  return discoverAndCacheAsync(ctx, scope);
}

export async function getCachedAgentCompletions(
  prefix: string,
  cwd = process.cwd(),
  cache: AgentDiscoveryCache = sharedAgentDiscoveryCache,
  cacheTtlMs = AGENT_DISCOVERY_CACHE_TTL_MS,
): Promise<{ value: string; label: string }[]> {
  return (await getCachedAgentDiscovery(cwd, "both", cache, cacheTtlMs)).agents
    .filter((agent) => agent.name.startsWith(prefix))
    .map((agent) => ({ value: agent.name, label: agent.name }));
}
