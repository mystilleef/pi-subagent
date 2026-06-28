/**
 * Generic resource resolution for skills and extensions.
 * Handles caching, discovery via DefaultResourceLoader, and name-to-path mapping.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const RESOURCE_DISCOVERY_CACHE_TTL_MS = 300_000;

export const EXTENSION_DISCOVERY_CACHE_TTL_MS = RESOURCE_DISCOVERY_CACHE_TTL_MS;

type ResourceCacheEntry<T> = {
  data: T;
  ts: number;
};

class ResourceCache<T> {
  private store = new Map<string, ResourceCacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (entry && Date.now() - entry.ts <= RESOURCE_DISCOVERY_CACHE_TTL_MS) {
      return entry.data;
    }
    return undefined;
  }

  set(key: string, data: T): void {
    this.store.set(key, { data, ts: Date.now() });
  }

  clear(): void {
    this.store.clear();
  }
}

const skillArgsCache = new ResourceCache<Map<string, string>>();
const extensionPathsCache = new ResourceCache<Map<string, string>>();

export function resetResolvedAgentSkillArgsCache(): void {
  skillArgsCache.clear();
}

export function resetResolvedAgentExtensionPathsCache(): void {
  extensionPathsCache.clear();
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    /* symlinks or missing paths fall back to absolute path resolution */
    return path.resolve(filePath);
  }
}

async function buildResourceCacheKey(
  cwd: string,
  agentDir: string,
  names: string[],
): Promise<string> {
  const sortedNames = [...names].sort();
  return JSON.stringify({
    cwd: await canonicalPath(cwd),
    agentDir: await canonicalPath(agentDir),
    names: sortedNames,
  });
}

type ResourceResolverResult<T> = { data: T } | { error: string };

interface ResourceResolverConfig<TResult> {
  cache: ResourceCache<Map<string, string>>;
  loaderOptions: Record<string, boolean>;
  getResources: (loader: DefaultResourceLoader) => {
    items: unknown[];
    errors: Array<{ path: string; error: string }>;
  };
  buildNameToResource: (items: unknown[]) => Map<string, string>;
  buildResult: (
    requested: string[],
    nameToResource: Map<string, string>,
  ) => TResult;
  resourceType: string;
}

async function resolveResources<TResult>(
  cwd: string,
  names: string[],
  config: ResourceResolverConfig<TResult>,
): Promise<ResourceResolverResult<TResult>> {
  const requested = Array.from(new Set(names));
  if (requested.length === 0) {
    return { data: config.buildResult(requested, new Map()) };
  }
  const agentDir = getAgentDir();
  const cacheKey = await buildResourceCacheKey(cwd, agentDir, requested);
  const cached = config.cache.get(cacheKey);
  if (cached) {
    return { data: config.buildResult(requested, cached) };
  }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    ...config.loaderOptions,
  });
  try {
    await loader.reload();
  } catch (error) {
    return {
      error: `Failed to discover ${config.resourceType}s: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { items, errors } = config.getResources(loader);
  if (errors.length > 0) {
    const details = errors.map((e) => `  ${e.path}: ${e.error}`).join("\n");
    return {
      error: `Failed to discover ${config.resourceType}s:\n${details}`,
    };
  }
  const nameToResource = config.buildNameToResource(items);
  const missing = requested.filter((name) => !nameToResource.has(name));
  if (missing.length > 0) {
    const available =
      Array.from(nameToResource.keys()).sort().join(", ") || "none";
    return {
      error: `Unknown ${config.resourceType}${missing.length === 1 ? "" : "s"}: ${missing
        .map((name) => `"${name}"`)
        .join(", ")}. Available ${config.resourceType}s: ${available}.`,
    };
  }
  const result = config.buildResult(requested, nameToResource);
  config.cache.set(cacheKey, nameToResource);
  return { data: result };
}

function buildSkillArgs(
  requested: string[],
  skillPaths: Map<string, string>,
): string[] {
  return requested.flatMap((name) => ["--skill", skillPaths.get(name) ?? name]);
}

export async function resolveAgentSkillArgs(
  cwd: string,
  skillNames: string[],
): Promise<{ args: string[] } | { error: string }> {
  const result = await resolveResources(cwd, skillNames, {
    cache: skillArgsCache,
    loaderOptions: {
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    },
    getResources: (loader) => {
      const { skills } = loader.getSkills();
      return {
        items: skills,
        errors: [],
      };
    },
    buildNameToResource: (items) => {
      const skillMap = new Map<string, string>();
      for (const item of items) {
        const skill = item as { name: string; filePath: string };
        skillMap.set(skill.name, skill.filePath ?? skill.name);
      }
      return skillMap;
    },
    buildResult: (requested, nameToResource) => {
      return buildSkillArgs(requested, nameToResource);
    },
    resourceType: "skill",
  });
  return "error" in result ? result : { args: result.data };
}

function getTerminalPackageName(source: string): string {
  const spec = source.startsWith("npm:") ? source.slice(4) : source;
  let name: string;
  if (spec.startsWith("@")) {
    const slashIdx = spec.indexOf("/");
    if (slashIdx >= 0) {
      name = spec.slice(slashIdx + 1);
    } else {
      name = spec;
    }
  } else {
    name = spec;
  }
  const versionIdx = name.indexOf("@");
  if (versionIdx >= 0) {
    return name.slice(0, versionIdx);
  }
  return name;
}

function isLocalPathSpec(source: string): boolean {
  return (
    source.startsWith(".") ||
    source.startsWith("/") ||
    source.startsWith("~") ||
    source.startsWith("file:")
  );
}

function buildExtensionShortName(ext: {
  resolvedPath: string;
  sourceInfo: { source: string; origin: string };
}): string {
  if (
    ext.sourceInfo.origin === "package" &&
    !isLocalPathSpec(ext.sourceInfo.source)
  ) {
    return getTerminalPackageName(ext.sourceInfo.source);
  }
  const fileName = path.basename(ext.resolvedPath);
  if (/^index\.(?:ts|js)$/.test(fileName)) {
    const dirName = path.dirname(ext.resolvedPath);
    const base = path.basename(dirName);
    if (base === "src" || base === "dist") {
      return path.basename(path.dirname(dirName));
    }
    return base;
  }
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx > 0) {
    return fileName.slice(0, dotIdx);
  }
  return fileName;
}

export async function resolveAgentExtensionPaths(
  cwd: string,
  extensionNames: string[],
): Promise<{ resolvedPaths: string[] } | { error: string }> {
  const result = await resolveResources(cwd, extensionNames, {
    cache: extensionPathsCache,
    loaderOptions: {
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      noSkills: true,
    },
    getResources: (loader) => {
      const { extensions, errors } = loader.getExtensions();
      const shortNameToExtension = new Map<
        string,
        (typeof extensions)[number]
      >();
      for (const ext of extensions) {
        const shortName = buildExtensionShortName(ext);
        if (!shortNameToExtension.has(shortName)) {
          shortNameToExtension.set(shortName, ext);
        }
      }
      return {
        items: Array.from(shortNameToExtension.values()),
        errors,
      };
    },
    buildNameToResource: (items) => {
      const shortNameToPath = new Map<string, string>();
      for (const item of items) {
        const ext = item as {
          resolvedPath: string;
          sourceInfo: { source: string; origin: string };
        };
        const shortName = buildExtensionShortName(ext);
        if (!shortNameToPath.has(shortName)) {
          shortNameToPath.set(shortName, ext.resolvedPath ?? shortName);
        }
      }
      return shortNameToPath;
    },
    buildResult: (requested, nameToResource) => {
      return requested
        .map((name) => nameToResource.get(name))
        .filter((p): p is string => typeof p === "string");
    },
    resourceType: "extension",
  });
  return "error" in result ? result : { resolvedPaths: result.data };
}
