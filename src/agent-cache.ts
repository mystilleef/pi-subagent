import path from "node:path";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

export type AgentDiscoveryCacheEntry = {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  ts: number;
};
export type AgentDiscoveryCache = Map<string, AgentDiscoveryCacheEntry>;
export const AGENT_DISCOVERY_CACHE_TTL_MS = 3_000;
const sharedAgentDiscoveryCache: AgentDiscoveryCache = new Map();
function getAgentDiscoveryCacheKey(cwd: string, scope: AgentScope): string {
  return `${path.resolve(cwd)}\0${scope}`;
}
function hasFreshAgentDiscoveryCacheEntry(
  entry: AgentDiscoveryCacheEntry | undefined,
  now: number,
  cacheTtlMs: number,
): entry is AgentDiscoveryCacheEntry {
  return Boolean(entry && now - entry.ts <= cacheTtlMs);
}
export function resetAgentDiscoveryCache(): void {
  sharedAgentDiscoveryCache.clear();
}
export function getCachedAgentDiscovery(
  cwd: string,
  scope: AgentScope,
  cache: AgentDiscoveryCache = sharedAgentDiscoveryCache,
  cacheTtlMs = AGENT_DISCOVERY_CACHE_TTL_MS,
): AgentDiscoveryCacheEntry {
  const key = getAgentDiscoveryCacheKey(cwd, scope);
  const now = Date.now();
  const entry = cache.get(key);
  if (hasFreshAgentDiscoveryCacheEntry(entry, now, cacheTtlMs)) return entry;
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
