import path from "node:path";
import {
  type AgentDiscoveryResult,
  type AgentScope,
  discoverAgentsAsync,
} from "./agents.js";

export type AgentDiscoveryCacheEntry = AgentDiscoveryResult & { ts: number };
export type AgentDiscoveryCache = Map<string, AgentDiscoveryCacheEntry>;
export const AGENT_DISCOVERY_CACHE_TTL_MS = 300_000;
const sharedAgentDiscoveryCache: AgentDiscoveryCache = new Map();

export function resetAgentDiscoveryCache(): void {
  sharedAgentDiscoveryCache.clear();
}

export async function getCachedAgentDiscovery(
  cwd: string,
  scope: AgentScope,
  cache: AgentDiscoveryCache = sharedAgentDiscoveryCache,
  cacheTtlMs = AGENT_DISCOVERY_CACHE_TTL_MS,
): Promise<AgentDiscoveryCacheEntry> {
  const key = `${path.resolve(cwd)}\0${scope}`;
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && now - entry.ts <= cacheTtlMs) return entry;
  const nextEntry = { ...(await discoverAgentsAsync(cwd, scope)), ts: now };
  cache.set(key, nextEntry);
  return nextEntry;
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
