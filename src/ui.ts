import type { Message } from "@mariozechner/pi-ai";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import {
  Box,
  type Component,
  Markdown,
  type MarkdownTheme,
  Text,
} from "@mariozechner/pi-tui";
import type { AgentScope } from "./agents.js";
import { extractSemanticToolTarget } from "./summary.js";
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

export function formatUsageStats(
  usage: UsageStats,
  model?: string,
  compact?: boolean,
): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input || usage.output) {
    const tokens: string[] = [];
    if (usage.input) tokens.push(`↑${formatTokens(usage.input)}`);
    if (usage.output) tokens.push(`↓${formatTokens(usage.output)}`);
    parts.push(tokens.join(" "));
  }
  if (!compact && (usage.cacheRead || usage.cacheWrite)) {
    const cache: string[] = [];
    if (usage.cacheRead) cache.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite) cache.push(`W${formatTokens(usage.cacheWrite)}`);
    parts.push(`cache:${cache.join("/")}`);
  }
  if (!compact && usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" · ");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatResultFooter(
  usage: UsageStats,
  model?: string,
  durationMs?: number,
): string {
  const parts: string[] = [];
  if (model) parts.push(model);
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (typeof durationMs === "number") parts.push(formatDuration(durationMs));
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" · ");
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
  forceJson = false,
): string {
  const target = extractSemanticToolTarget(toolName, args, forceJson);
  if (!target) return themeFg("accent", toolName);
  return themeFg("accent", toolName) + themeFg("dim", ` ${target}`);
}

export function getFinalOutput(messages: Message[]): string {
  const lastAsst = messages.findLast((m) => m.role === "assistant");
  const lastText = lastAsst?.content.findLast((p) => p.type === "text");
  return lastText?.type === "text" ? lastText.text : "";
}

function stripOutcomeLineForResultUi(output: string): string {
  const stripped = output.replace(/^\s*Outcome:[^\r\n]*(?:\r?\n|$)/gim, "");
  return stripped.trim() ? stripped : output;
}

function makeMarkdownTheme(theme: SubagentTheme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => `\x1b[3m${text}\x1b[23m`,
    strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
    underline: (text) => `\x1b[4m${text}\x1b[24m`,
  };
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
  _display?: { isPartial?: boolean },
  bodyOverride?: string,
): Component {
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
  const finalOutput = r.finalOutput ?? getFinalOutput(r.messages ?? []);
  const bg = failed ? "toolErrorBg" : "toolSuccessBg";
  const box = new Box(0, 0, (line) => theme.bg(bg, line));
  const bodyText = stripOutcomeLineForResultUi(bodyOverride ?? finalOutput);
  if (bodyText) {
    box.addChild(
      new Markdown(bodyText, 0, 0, makeMarkdownTheme(theme), {
        color: (text) => theme.fg("toolOutput", text),
      }),
    );
  } else {
    box.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
  }
  const usageStr = formatResultFooter(r.usage, r.model, r.durationMs);
  if (usageStr) box.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
  return box;
}
