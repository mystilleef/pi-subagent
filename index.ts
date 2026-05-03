/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports a single mode: { agent: "name", task: "..." }.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import readline from "node:readline";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  type ThemeColor,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
  type AgentConfig,
  type AgentScope,
  discoverAgents,
  type ThinkingLevel,
} from "./agents.js";

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "both" (user + project-local agents).',
  default: "both",
});

export const SubagentParams = Type.Object({
  agent: Type.String({
    description: "Name of the agent to invoke",
  }),
  task: Type.String({ description: "Task to delegate" }),
  agentScope: Type.Optional(AgentScopeSchema),
});

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentDetails {
  mode: "single";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function waitForSubagentProcess(
  proc: ChildProcess,
  idleMs = 100,
  hardMs = 5_000,
): Promise<number | null> {
  return new Promise((resolve) => {
    let exitCode: number | null = null;
    let exited = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;

    const done = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(exitCode);
    };

    const destroyStreams = () => {
      try {
        proc.stdout?.destroy();
      } catch {}
      try {
        proc.stderr?.destroy();
      } catch {}
    };

    const armIdleTimer = () => {
      if (!exited) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(destroyStreams, idleMs);
      idleTimer.unref?.();
    };

    // close fires after all stdio streams drain — correct event to await
    proc.on("close", done);

    proc.on("exit", (code) => {
      exitCode = code;
      exited = true;
      armIdleTimer();
      // hard fallback if grandchild holds the pipe open indefinitely
      hardTimer = setTimeout(destroyStreams, hardMs);
      hardTimer.unref?.();
    });

    // reset idle timer on each incoming chunk
    proc.stdout?.on("data", armIdleTimer);
    proc.stderr?.on("data", armIdleTimer);
  });
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
): string {
  let preview = "";
  if (toolName === "bash" && typeof args.command === "string") {
    preview = args.command;
  } else if (
    ["read", "write", "edit", "file_search"].includes(toolName) &&
    typeof args.path === "string"
  ) {
    preview = args.path;
  } else if (toolName === "subagent" && typeof args.agent === "string") {
    preview = args.agent;
  } else {
    preview = JSON.stringify(args);
  }

  if (preview.length > 50) {
    preview = `${preview.slice(0, 50)}...`;
  }

  return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
}

function getFinalOutput(messages: Message[]): string {
  const lastAsst = messages.findLast((m) => m.role === "assistant");
  const lastText = lastAsst?.content.findLast((p) => p.type === "text");
  return lastText?.type === "text" ? lastText.text : "";
}

const MAX_OUTPUT_BYTES = 100_000;
const MAX_OUTPUT_LINES = 500;

function truncateOutput(text: string): string {
  const lines = text.split("\n");
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= MAX_OUTPUT_BYTES && lines.length <= MAX_OUTPUT_LINES)
    return text;
  let result = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  if (Buffer.byteLength(result, "utf-8") > MAX_OUTPUT_BYTES) {
    const buf = Buffer.from(result).subarray(0, MAX_OUTPUT_BYTES);
    result = buf.toString("utf-8").replace(/�$/, "");
  }
  const kept = result.split("\n").length;
  return `[TRUNCATED: first ${kept} of ${lines.length} lines]\n${result}`;
}

async function writePromptToTempFile(
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

function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

async function resolveAgentSkillArgs(
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

const MAX_SUBAGENT_DEPTH = 3;

function getSubagentDepth(): number {
  const d = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  return Number.isFinite(d) ? d : 0;
}

function subagentDepthEnv(): Record<string, string> {
  return { PI_SUBAGENT_DEPTH: String(getSubagentDepth() + 1) };
}

function detectMessageError(messages: Message[]): boolean {
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

async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  parentModel: { provider: string; id: string } | undefined,
  parentThinking: ThinkingLevel,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return createErrorResult(
      agentName,
      "unknown",
      task,
      `Unknown agent: "${agentName}". Available agents: ${available}.`,
    );
  }

  const depth = getSubagentDepth();
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return createErrorResult(
      agentName,
      agent.source,
      task,
      `Subagent nesting limit reached (depth ${depth}/${MAX_SUBAGENT_DEPTH}).`,
    );
  }

  const thinking = agent.thinking ?? parentThinking;
  const modelDisplay = parentModel
    ? `${parentModel.provider}/${parentModel.id}${thinking ? `:${thinking}` : ""}`
    : thinking
      ? `thinking:${thinking}`
      : undefined;

  const resolvedSkills = agent.skills
    ? await resolveAgentSkillArgs(defaultCwd, agent.skills)
    : { args: [] };

  if ("error" in resolvedSkills) {
    return createErrorResult(
      agentName,
      agent.source,
      task,
      resolvedSkills.error,
      modelDisplay,
    );
  }

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: modelDisplay,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text:
            truncateOutput(getFinalOutput(currentResult.messages)) ||
            "(running...)",
        },
      ],
      details: makeDetails([currentResult]),
    });
  };

  let tmpPrompt: { dir: string; filePath: string } | null = null;
  try {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (parentModel)
      args.push("--provider", parentModel.provider, "--model", parentModel.id);
    args.push("--thinking", thinking);
    if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
    if (agent.skills) args.push("--no-skills", ...resolvedSkills.args);

    if (agent.systemPrompt.trim()) {
      tmpPrompt = await writePromptToTempFile(agent.name, agent.systemPrompt);
      args.push("--append-system-prompt", tmpPrompt.filePath);
    }

    args.push(`Task: ${task}`);

    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: defaultCwd,
      shell: invocation.command === "pi" && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...subagentDepthEnv() },
    });

    let wasAborted = false;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (
          (event.type === "message_end" || event.type === "tool_result_end") &&
          event.message
        ) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model)
              currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "agent_end") {
          proc.kill("SIGTERM");
        }
      } catch {
        /* ignore invalid JSON */
      }
    };

    readline.createInterface({ input: proc.stdout }).on("line", processLine);

    proc.stderr.on("data", (data) => {
      if (currentResult.stderr.length < 10_000)
        currentResult.stderr += data.toString();
    });

    if (signal) {
      const onAbort = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    currentResult.exitCode = (await waitForSubagentProcess(proc)) ?? 0;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPrompt) {
      try {
        fs.unlinkSync(tmpPrompt.filePath);
        fs.rmdirSync(tmpPrompt.dir);
      } catch {
        /* ignore */
      }
    }
  }
}

function createErrorResult(
  agent: string,
  source: "user" | "project" | "unknown",
  task: string,
  error: string,
  model?: string,
): SingleResult {
  return {
    agent,
    agentSource: source,
    task,
    exitCode: 1,
    messages: [],
    stderr: error,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model,
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);

        // Match `/run ` followed by an incomplete agent name (no spaces)
        const match = beforeCursor.match(/(?:^|[ \t])\/run\s+([^\s]*)$/);
        if (!match) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const prefix = match[1] ?? "";
        // Default to "both" scopes for completion
        const agents = discoverAgents(ctx.cwd, "both").agents;

        return {
          prefix,
          items: agents
            .filter((a) => a.name.startsWith(prefix))
            .map((a) => ({ value: a.name, label: a.name })),
        };
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        );
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return (
          current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
          true
        );
      },
    }));
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate one task to one specialized subagent with isolated context.",
      "Mode: single (agent + task).",
      'Default agent scope is "both" (user agents from ~/.pi/agents and project-local agents from .pi/agents).',
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "both";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const parentModel = ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined;
      const parentThinking = pi.getThinkingLevel() as ThinkingLevel;

      const makeDetails = (results: SingleResult[]): SubagentDetails => ({
        mode: "single",
        agentScope,
        projectAgentsDir: discovery.projectAgentsDir,
        results,
      });

      if ((agentScope === "project" || agentScope === "both") && ctx.hasUI) {
        const requested = agents.find((a) => a.name === params.agent);
        if (requested?.source === "project") {
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agent?",
            `Agent: ${requested.name}
Source: ${dir}

Project agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok)
            return {
              content: [
                {
                  type: "text",
                  text: "Canceled: project-local agent not approved.",
                },
              ],
              details: makeDetails([]),
            };
        }
      }

      const result = await runSingleAgent(
        ctx.cwd,
        agents,
        params.agent,
        params.task,
        signal,
        onUpdate,
        makeDetails,
        parentModel,
        parentThinking,
      );
      const failed =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted" ||
        detectMessageError(result.messages);
      if (failed) {
        const errorMsg =
          result.errorMessage ||
          result.stderr ||
          getFinalOutput(result.messages) ||
          "(no output)";
        throw new Error(`Agent ${result.stopReason || "failed"}: ${errorMsg}`);
      }
      return {
        content: [
          {
            type: "text",
            text:
              truncateOutput(getFinalOutput(result.messages)) || "(no output)",
          },
        ],
        details: makeDetails([result]),
      };
    },

    renderCall(args, theme, _context) {
      const scope: AgentScope = args.agentScope ?? "both";
      const agentName = args.agent || "...";
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName) +
        theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _display, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      const r = details?.results?.[0];
      if (!r) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }

      const failed =
        r.exitCode !== 0 ||
        r.stopReason === "error" ||
        r.stopReason === "aborted" ||
        detectMessageError(r.messages);
      const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const finalOutput = getFinalOutput(r.messages);

      let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
      if (failed && r.stopReason)
        text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;

      if (failed && r.errorMessage) {
        text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
      } else {
        const lastTool = r.messages
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.content)
          .findLast((p) => p.type === "toolCall");

        if (lastTool?.type === "toolCall") {
          text += `\n${theme.fg("muted", "→ ") + formatToolCall(lastTool.name, lastTool.arguments, theme.fg.bind(theme))}`;
        }

        if (finalOutput.trim()) {
          const preview = finalOutput.trim().split("\n").slice(0, 2).join("\n");
          text += `\n${theme.fg("toolOutput", preview)}`;
        } else if (!lastTool) {
          text += `\n${theme.fg("muted", "(no output)")}`;
        }
      }

      const usageStr = formatUsageStats(r.usage, r.model);
      if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
      return new Text(text, 0, 0);
    },
  });
}
