import type { Message } from "@mariozechner/pi-ai";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AgentScope } from "./agents.js";
import type { SubagentDetails, UsageStats } from "./types.js";
import { detectMessageError } from "./utils.js";

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
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

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
  forceJson = false,
): string {
  let preview = "";
  if (forceJson) {
    preview = JSON.stringify(args);
  } else if (toolName === "bash" && typeof args.command === "string") {
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

export function getFinalOutput(messages: Message[]): string {
  const lastAsst = messages.findLast((m) => m.role === "assistant");
  const lastText = lastAsst?.content.findLast((p) => p.type === "text");
  return lastText?.type === "text" ? lastText.text : "";
}

export function renderSubagentCall(
  args: { agent?: string; task?: string; agentScope?: AgentScope },
  theme: {
    fg: (color: ThemeColor, text: string) => string;
    bold: (text: string) => string;
  },
): Text {
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
}

export function renderSubagentResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  theme: {
    fg: (color: ThemeColor, text: string) => string;
    bold: (text: string) => string;
  },
  display?: { isPartial?: boolean },
): Text {
  const details = result.details as SubagentDetails | undefined;
  const r = details?.results?.[0];
  if (!r) {
    const text = result.content[0];
    return new Text(
      text?.type === "text" ? (text.text ?? "(no output)") : "(no output)",
      0,
      0,
    );
  }
  const failed =
    r.exitCode !== 0 ||
    r.stopReason === "error" ||
    r.stopReason === "aborted" ||
    !!r.errorMessage ||
    detectMessageError(r.messages ?? []);
  const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const finalOutput = r.finalOutput ?? getFinalOutput(r.messages ?? []);
  let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
  if (failed && r.stopReason)
    text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  if (failed && r.errorMessage) {
    text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
  } else {
    const lastTool = (r.messages ?? [])
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .findLast((p) => p.type === "toolCall");
    if (lastTool?.type === "toolCall") {
      const showRawArgs = display?.isPartial === true && failed;
      text += `\n${theme.fg("muted", "→ ") + formatToolCall(lastTool.name, lastTool.arguments as Record<string, unknown>, theme.fg.bind(theme), showRawArgs)}`;
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
}
