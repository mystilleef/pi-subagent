import type { Message } from "@mariozechner/pi-ai";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AgentScope } from "./agents.js";
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

type SummaryLabel = "Outcome" | "Changed" | "Evidence" | "Next" | "Cause";

const SUMMARY_LABELS: SummaryLabel[] = [
  "Outcome",
  "Changed",
  "Evidence",
  "Next",
  "Cause",
];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function normalizeLabel(raw: string): SummaryLabel | undefined {
  return SUMMARY_LABELS.find(
    (label) => label.toLowerCase() === raw.toLowerCase(),
  );
}

function extractSummaryLabels(
  output: string,
): Partial<Record<SummaryLabel, string>> {
  const summary: Partial<Record<SummaryLabel, string>> = {};
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  let active: SummaryLabel | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(
      /^#{1,6}\s+(Outcome|Changed|Evidence|Next|Cause)(?:\s*:\s*|\s+)?(.*)$/i,
    );
    const inline =
      line.match(
        /^(?:[-*]\s*)?(?:\*\*)?(Outcome|Changed|Evidence|Next|Cause)\s*:\*\*\s*(.*)$/i,
      ) ??
      line.match(
        /^(?:[-*]\s*)?(?:\*\*)?(Outcome|Changed|Evidence|Next|Cause)(?:\*\*)?\s*:\s*(.*)$/i,
      );
    if (heading) {
      active = normalizeLabel(heading[1] ?? "");
      const value = heading[2]?.trim();
      if (active && value) summary[active] = value;
      continue;
    }
    if (inline) {
      active = normalizeLabel(inline[1] ?? "");
      const value = inline[2]?.trim();
      if (active && value) summary[active] = value;
      continue;
    }
    if (active) {
      summary[active] = summary[active] ? `${summary[active]} ${line}` : line;
    }
  }
  return summary;
}

function looksLikePath(value: string): boolean {
  return /^(?:\.{1,2}\/|\/|[\w.-]+\/|[\w.-]+\.[\w.-]+$)/.test(value);
}

function compactChangedPathList(value: string): string {
  const paths = value.split(",").map((part) => part.trim());
  if (paths.length <= 4 || paths.some((path) => !looksLikePath(path)))
    return value;
  return `${paths.length} files: ${paths.slice(0, 4).join(", ")}, …`;
}

function normalizeSummaryValue(value: string, label?: SummaryLabel): string {
  let normalized = value.trim().replace(/\s+/g, " ");
  const wrapper = normalized.match(/^(?:`([^`]+)`|\*\*([^*]+)\*\*)$/);
  if (wrapper) normalized = (wrapper[1] ?? wrapper[2] ?? "").trim();
  if (label === "Changed") normalized = compactChangedPathList(normalized);
  if (normalized.length > 160) normalized = `${normalized.slice(0, 160)}…`;
  return normalized;
}

function isNoOpSummaryValue(value: string): boolean {
  return /^(?:none|n\/a|na|nothing|no changes|unchanged|not applicable)$/i.test(
    value.trim(),
  );
}

function formatSummary(
  output: string,
  failed: boolean,
  theme: SubagentTheme,
): string[] {
  const summary = extractSummaryLabels(output);
  const labels: SummaryLabel[] = failed
    ? ["Cause", "Evidence", "Next"]
    : ["Outcome", "Changed", "Evidence", "Next"];
  const lines = labels.flatMap((label) => {
    const value = summary[label]
      ? normalizeSummaryValue(summary[label], label)
      : "";
    if (!value || isNoOpSummaryValue(value)) return [];
    return `${theme.fg("muted", `${label}:`)} ${theme.fg("toolOutput", value)}`;
  });
  if (lines.length) return lines;
  const fallback = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (fallback.length)
    return fallback.map((line) => theme.fg("toolOutput", line));
  return [theme.fg("muted", "(no output)")];
}

export function renderSubagentCall(
  args: { agent?: string; task?: string; agentScope?: AgentScope },
  theme: SubagentTheme,
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
