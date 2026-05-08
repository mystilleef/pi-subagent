import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_MAX_OUTPUT_BYTES = 50_000;
export const DEFAULT_MAX_OUTPUT_LINES = 500;

export interface SubagentOutputLimits {
  maxBytes: number;
  maxLines: number;
}

type OutputLimitConfig = Partial<Record<string, string | number | undefined>>;

function parsePositiveInteger(
  value: string | number | undefined,
): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

export function getSubagentOutputLimits(
  config: OutputLimitConfig = process.env,
): SubagentOutputLimits {
  return {
    maxBytes:
      parsePositiveInteger(config.PI_SUBAGENT_MAX_OUTPUT_BYTES) ??
      DEFAULT_MAX_OUTPUT_BYTES,
    maxLines:
      parsePositiveInteger(config.PI_SUBAGENT_MAX_OUTPUT_LINES) ??
      DEFAULT_MAX_OUTPUT_LINES,
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
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, {
      encoding: "utf-8",
      mode: 0o600,
    });
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

export async function resolveAgentSkillArgs(
  cwd: string,
  skillNames: string[],
): Promise<{ args: string[] } | { error: string }> {
  const requested = Array.from(new Set(skillNames));
  if (requested.length === 0) return { args: [] };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
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
  return {
    args: requested.flatMap((name) => [
      "--skill",
      skillMap.get(name)?.filePath ?? name,
    ]),
  };
}

export function getSubagentDepth(): number {
  const d = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  if (!Number.isFinite(d) || d < 0) return 0;
  return Math.floor(d);
}

export function subagentDepthEnv(): Record<string, string> {
  return { PI_SUBAGENT_DEPTH: String(getSubagentDepth() + 1) };
}

export function detectMessageError(messages: Message[]): boolean {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg?.role === "assistant" &&
      msg.content.some((c) => c.type === "text" && c.text.trim().length > 0)
    ) {
      lastAssistantIdx = i;
      break;
    }
  }
  const from = lastAssistantIdx >= 0 ? lastAssistantIdx + 1 : 0;
  for (let i = messages.length - 1; i >= from; i--) {
    const msg = messages[i];
    if (msg?.role === "toolResult" && msg.isError) return true;
  }
  return false;
}
