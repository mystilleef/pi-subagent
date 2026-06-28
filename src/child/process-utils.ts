/**
 * Utility functions for child process management.
 * Handles byte-limited string appending, UTF-8 truncation, and context window resolution.
 */

import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveExtensionPath(baseName: string, dir?: string): string {
  const resolvedDir = dir ?? __dirname;
  const ext = __filename.endsWith(".ts") ? ".ts" : ".js";
  const primary = path.join(resolvedDir, `${baseName}${ext}`);
  if (fs.existsSync(primary)) return primary;
  const altExt = ext === ".ts" ? ".js" : ".ts";
  const fallback = path.join(resolvedDir, `${baseName}${altExt}`);
  if (fs.existsSync(fallback)) return fallback;
  throw new Error(`${baseName} not found at ${primary} or ${fallback}`);
}

/**
 * Resolves the absolute path to the complete-extension file.
 * Prefers the extension matching the current runtime, then falls back to the
 * alternate extension. Throws if neither exists.
 * Pass `dir` in tests to use a controlled directory.
 */
export function resolveCompleteExtensionPath(dir?: string): string {
  return resolveExtensionPath("complete-extension", dir);
}

/**
 * Resolves the absolute path to the sampling-extension file.
 * Prefers the extension matching the current runtime, then falls back to the
 * alternate extension. Throws if neither exists.
 * Pass `dir` in tests to use a controlled directory.
 */
export function resolveSamplingExtensionPath(dir?: string): string {
  return resolveExtensionPath("sampling-extension", dir);
}

/**
 * Resolves the absolute path to the pi-subagent package entry extension file.
 * This is the main index that registers the subagent tool and commands.
 * Prefers the extension matching the current runtime, then falls back to the
 * alternate extension. Throws if neither exists.
 * Pass `dir` in tests to use a controlled directory.
 */
export function resolvePackageExtensionPath(dir?: string): string {
  return resolveExtensionPath("../index", dir);
}

/**
 * Appends data to a string while enforcing a maximum byte limit.
 * Handles both string and Buffer inputs, truncating at valid UTF-8 boundaries.
 */
export function appendWithByteLimit(
  current: string,
  data: string | Buffer,
  max: number,
): string {
  const currentBytes = Buffer.from(current, "utf-8");
  if (currentBytes.length >= max) return current;
  const incomingBytes = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data, "utf-8");
  const combined = Buffer.concat([currentBytes, incomingBytes]);
  if (combined.length <= max) return combined.toString("utf-8");
  return truncateValidUtf8(combined, max);
}

/**
 * Truncates a buffer to the specified byte limit while preserving valid UTF-8 sequences.
 * Returns an empty string if no valid truncation point is found.
 */
export function truncateValidUtf8(buffer: Buffer, max: number): string {
  let end = Math.min(max, buffer.length);
  while (end > 0) {
    const candidate = buffer.subarray(0, end).toString("utf-8");
    if (!candidate.endsWith("�")) return candidate;
    end -= 1;
  }
  return "";
}

/**
 * Resolves the context window size in tokens for a given message.
 * Returns undefined if the message doesn't have valid provider/model info
 * or if the model lookup fails.
 *
 * Rationale: Subagent usage reporting needs context window awareness to provide
 * meaningful "context full" indicators to the parent.
 */
export function resolveContextWindowTokens(msg: Message): number | undefined {
  const m = msg as unknown as Record<string, unknown>;
  if (typeof m["provider"] !== "string" || typeof m["model"] !== "string")
    return;
  try {
    const contextWindow = getModel(
      m["provider"] as never,
      m["model"] as never,
    )?.contextWindow;
    return Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  } catch {
    /* model lookup failures return undefined to skip context window tracking */
    return;
  }
}
