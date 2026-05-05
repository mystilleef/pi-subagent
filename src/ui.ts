import type { Message } from "@mariozechner/pi-ai";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AgentScope } from "./agents.js";
import {
  extractSemanticToolTarget,
  extractSummaryLabels,
  formatSemanticFallbackOutput,
  isNoOpSummaryValue,
  normalizeSummaryValue,
  type SummaryLabel,
} from "./summary.js";
import type { SubagentDetails, UsageStats } from "./types.js";
import { detectMessageError } from "./utils.js";

export type ThemeBg = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export type SubagentTheme = {
  fg: (color: ThemeColor, text: string) => string;
  bg: (color: ThemeBg, text: string) => string;
  bold: (text: string) => string;
};

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
  if (usage.input || usage.output) {
    const tokens: string[] = [];
    if (usage.input) tokens.push(`↑${formatTokens(usage.input)}`);
    if (usage.output) tokens.push(`↓${formatTokens(usage.output)}`);
    parts.push(tokens.join(" "));
  }
  if (usage.cacheRead || usage.cacheWrite) {
    const cache: string[] = [];
    if (usage.cacheRead) cache.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite) cache.push(`W${formatTokens(usage.cacheWrite)}`);
    parts.push(`cache:${cache.join("/")}`);
  }
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" · ");
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
  forceJson = false,
): string {
  const target = extractSemanticToolTarget(toolName, args, forceJson);
  return themeFg("accent", toolName) + themeFg("dim", ` ${target}`);
}

export function getFinalOutput(messages: Message[]): string {
  const lastAsst = messages.findLast((m) => m.role === "assistant");
  const lastText = lastAsst?.content.findLast((p) => p.type === "text");
  return lastText?.type === "text" ? lastText.text : "";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function formatSummary(
  output: string,
  failed: boolean,
  theme: SubagentTheme,
): string[] {
  const summary = extractSummaryLabels(output);
  const labels: SummaryLabel[] = failed
    ? ["Cause", "Verification", "Next"]
    : ["Outcome", "Changed", "Verification", "Next"];
  const lines = labels.flatMap((label) => {
    const value = summary[label]
      ? normalizeSummaryValue(summary[label], label)
      : "";
    if (!value || isNoOpSummaryValue(value)) return [];
    return `${theme.fg("muted", `${label}:`)} ${theme.fg("toolOutput", value)}`;
  });
  if (lines.length) return lines;
  const fallback = formatSemanticFallbackOutput(output);
  if (fallback) return [theme.fg("toolOutput", fallback)];
  return [theme.fg("muted", "(no output)")];
}

export function renderSubagentCall(
  args: { agent?: string; task?: string; agentScope?: AgentScope },
  theme: SubagentTheme,
): Text {
  const scope: AgentScope = args.agentScope ?? "both";
  const agentName = args.agent || "...";
  const target = extractSemanticToolTarget("subagent", args);
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", agentName) +
    theme.fg("muted", ` [${scope}]`);
  text += `\n  ${theme.fg("dim", target)}`;
  return new Text(text, 0, 0, (line) => theme.bg("toolPendingBg", line));
}

export function renderSubagentResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  theme: SubagentTheme,
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
  const headerParts = [
    theme.fg("toolTitle", theme.bold(r.agent)),
    theme.fg("muted", r.agentSource),
  ];
  if (r.durationMs !== undefined) {
    headerParts.push(theme.fg("muted", formatDuration(r.durationMs)));
  }
  let text = `${icon} ${headerParts.join(theme.fg("muted", " · "))}`;
  if (failed && r.stopReason)
    text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  const lastTool = (r.messages ?? [])
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .findLast((p) => p.type === "toolCall");
  if (lastTool?.type === "toolCall") {
    const showRawArgs = display?.isPartial === true && failed;
    text += `\n${theme.fg("muted", "→ ") + formatToolCall(lastTool.name, lastTool.arguments as Record<string, unknown>, theme.fg.bind(theme), showRawArgs)}`;
  }
  const parsedFinalSummary = extractSummaryLabels(finalOutput);
  const bodySource =
    failed && r.errorMessage && !parsedFinalSummary.Cause
      ? `Cause: ${r.errorMessage}\n${finalOutput}`
      : finalOutput;
  text += `\n${formatSummary(bodySource, failed, theme).join("\n")}`;
  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
  return new Text(text, 0, 0, (line) =>
    theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", line),
  );
}
