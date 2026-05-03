import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import {
  DefaultResourceLoader,
  getAgentDir,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";

const MAX_OUTPUT_BYTES = 100_000;
const MAX_OUTPUT_LINES = 500;

export function truncateOutput(text: string): string {
  const lines = text.split("\n");
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= MAX_OUTPUT_BYTES && lines.length <= MAX_OUTPUT_LINES)
    return text;

  let result = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  if (Buffer.byteLength(result, "utf-8") > MAX_OUTPUT_BYTES) {
    const buf = Buffer.from(result).subarray(0, MAX_OUTPUT_BYTES);
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
  return Number.isFinite(d) ? d : 0;
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
