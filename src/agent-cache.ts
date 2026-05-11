import path from "node:path";
import { type AgentDiscoveryResult, type AgentScope, discoverAgents } from "./agents.js";

export type AgentDiscoveryCacheEntry = AgentDiscoveryResult & { ts: number };
export type AgentDiscoveryCache = Map<string, AgentDiscoveryCacheEntry>;
export const AGENT_DISCOVERY_CACHE_TTL_MS = 3_000;
const sharedAgentDiscoveryCache: AgentDiscoveryCache = new Map();

export function resetAgentDiscoveryCache(): void {
  sharedAgentDiscoveryCache.clear();
}

export function getCachedAgentDiscovery(
  cwd: string,
  scope: AgentScope,
  cache: AgentDiscoveryCache = sharedAgentDiscoveryCache,
  cacheTtlMs = AGENT_DISCOVERY_CACHE_TTL_MS,
): AgentDiscoveryCacheEntry {
  const key = `${path.resolve(cwd)}\0${scope}`;
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && now - entry.ts <= cacheTtlMs) return entry;
  const nextEntry = { ...discoverAgents(cwd, scope), ts: now };
  cache.set(key, nextEntry);
  return nextEntry;
}

export function getCachedAgentCompletions(
  prefix: string,
  cwd = process.cwd(),
  cache: AgentDiscoveryCache = sharedAgentDiscoveryCache,
  cacheTtlMs = AGENT_DISCOVERY_CACHE_TTL_MS,
): { value: string; label: string }[] {
  return getCachedAgentDiscovery(cwd, "both", cache, cacheTtlMs)
    .agents.filter((agent) => agent.name.startsWith(prefix))
    .map((agent) => ({ value: agent.name, label: agent.name }));
}
