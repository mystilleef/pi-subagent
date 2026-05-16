import type { Message } from "@earendil-works/pi-ai";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Markdown,
  type MarkdownTheme,
  Text,
} from "@earendil-works/pi-tui";
import type { AgentScope } from "./agents.js";
import {
  extractSemanticToolTarget,
  normalizeSummaryValue,
} from "./normalize.js";
import {
  formatContextPercent,
  formatElapsed,
  type ProgressStatus,
  STATUS_COLOR,
  STATUS_ICON,
  type SubagentProgressState,
  type ThemeBg,
} from "./progress-state.js";
import { hasSubagentFailed } from "./result-details.js";
import type { SubagentDetails, UsageStats } from "./types.js";

export type { ThemeBg };

/**
 * Abstraction for theme-aware text formatting.
 */
export type SubagentTheme = {
  fg: (color: ThemeColor, text: string) => string;
  bg: (color: ThemeBg, text: string) => string;
  bold: (text: string) => string;
  italic?: (text: string) => string;
};

const ANSI_ITALIC_ON = "\x1b[3m";
const ANSI_ITALIC_OFF = "\x1b[23m";
const ANSI_STRIKETHROUGH_ON = "\x1b[9m";
const ANSI_STRIKETHROUGH_OFF = "\x1b[29m";
const ANSI_UNDERLINE_ON = "\x1b[4m";
const ANSI_UNDERLINE_OFF = "\x1b[24m";

function italicText(text: string, theme: SubagentTheme): string {
  return theme.italic
    ? theme.italic(text)
    : `${ANSI_ITALIC_ON}${text}${ANSI_ITALIC_OFF}`;
}

/**
 * Formats the shared subagent title from agent and optional instance name.
 */
export function formatSubagentTitle(
  agent: string,
  instanceName: string | undefined,
  theme: SubagentTheme,
): string {
  const agentSegment = theme.fg("toolTitle", theme.bold(agent));
  if (!instanceName) return agentSegment;
  return `${agentSegment} ${theme.fg("accent", italicText(instanceName, theme))}`;
}

/**
 * Formats token counts into human-readable strings (e.g., "1.2k", "1.5M").
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Formats cumulative usage statistics for compact UI display.
 */
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

/**
 * Formats millisecond durations into human-readable time strings.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

/**
 * Formats the footer for subagent result cards, including model, context, turns, and cost.
 */
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
  return `\n${parts.join(" · ")}`;
}

/**
 * Formats a tool call for the UI, optionally extracting a semantic target for clarity.
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
  forceJson = false,
): string {
  const target = normalizeSummaryValue(
    extractSemanticToolTarget(toolName, args, forceJson),
  );
  if (!target) return themeFg("accent", toolName);
  return themeFg("accent", toolName) + themeFg("dim", ` ${target}`);
}

/**
 * Extracts the final text response from an array of assistant messages.
 */
export function getFinalOutput(messages: Message[]): string {
  const lastAsst = messages.findLast((m) => m.role === "assistant");
  const lastText = lastAsst?.content.findLast((p) => p.type === "text");
  return lastText?.type === "text" ? lastText.text : "";
}

/**
 * Removes the "Outcome:" line from subagent output to avoid redundancy in result cards.
 */
function stripOutcomeLineForResultUi(output: string): string {
  const stripped = output.replace(/^\s*Outcome:[^\r\n]*(?:\r?\n|$)/gim, "");
  return stripped.trim() ? stripped : output;
}

/**
 * Maps subagent theme colors to Markdown rendering components.
 */
function makeMarkdownTheme(theme: SubagentTheme): MarkdownTheme {
  const fg = (c: ThemeColor) => (text: string) => theme.fg(c, text);
  return {
    heading: fg("mdHeading"),
    link: fg("mdLink"),
    linkUrl: fg("mdLinkUrl"),
    code: fg("mdCode"),
    codeBlock: fg("mdCodeBlock"),
    codeBlockBorder: fg("mdCodeBlockBorder"),
    quote: fg("mdQuote"),
    quoteBorder: fg("mdQuoteBorder"),
    hr: fg("mdHr"),
    listBullet: fg("mdListBullet"),
    bold: (text) => theme.bold(text),
    italic: (text) => `${ANSI_ITALIC_ON}${text}${ANSI_ITALIC_OFF}`,
    strikethrough: (text) =>
      `${ANSI_STRIKETHROUGH_ON}${text}${ANSI_STRIKETHROUGH_OFF}`,
    underline: (text) => `${ANSI_UNDERLINE_ON}${text}${ANSI_UNDERLINE_OFF}`,
  };
}

/**
 * Renders the pending subagent call UI component.
 */
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

/**
 * Renders the subagent result box.
 *
 * Invariants:
 * - Red background indicates failure (exit code, error reason, or message error).
 * - Green background indicates success.
 * - Trims redundant "Outcome:" lines from the body.
 * - Displays usage stats and duration in the footer.
 */
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
  const failed = hasSubagentFailed(r);
  const cancelled = r.stopReason === "aborted";
  const resultStatus: ProgressStatus = cancelled
    ? "cancelled"
    : failed
      ? "error"
      : "success";
  const finalOutput = r.finalOutput ?? getFinalOutput(r.messages ?? []);
  const bg = failed ? "toolErrorBg" : "toolSuccessBg";
  const box = new Box(1, 1, (line) => theme.bg(bg, line));
  const title = formatSubagentTitle(r.agent, r.instanceName, theme);
  const icon = theme.fg(STATUS_COLOR[resultStatus], STATUS_ICON[resultStatus]);
  box.addChild(new Text(`${icon} ${title}`, 0, 0));
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
/**
 * Renders a unified job board for the `/runs` command.
 * Active (running) jobs render first, then completed; both groups sorted by `startTime` descending.
 * Status icons are overridden locally: running → ●, cancelled → ✗.
 */
export function renderRunsBoard(
  states: SubagentProgressState[],
  theme: SubagentTheme,
): Component {
  if (states.length === 0) {
    return new Text(theme.fg("muted", "No /run jobs in this session."), 0, 0);
  }
  const active = states.filter((s) => s.status === "running");
  const completed = states.filter((s) => s.status !== "running");
  active.sort((a, b) => b.startTime - a.startTime);
  completed.sort((a, b) => b.startTime - a.startTime);
  const ordered = [...active, ...completed];
  const box = new Box(0, 0);
  for (const state of ordered) {
    const icon =
      state.status === "running"
        ? "●"
        : state.status === "cancelled"
          ? "✗"
          : STATUS_ICON[state.status];
    const color = STATUS_COLOR[state.status];
    const title = formatSubagentTitle(state.agent, state.instanceName, theme);
    const elapsed = formatElapsed(
      state.durationMs ?? Date.now() - state.startTime,
    );
    const ctxPercent = formatContextPercent(state);
    const toolLabel = state.toolCount === 1 ? "tool" : "tools";
    const header = `${theme.fg(color, icon)} ${title} ${theme.fg("dim", `[${state.status}]`)} ${theme.fg("muted", `${state.toolCount} ${toolLabel} · ${ctxPercent} ctx · ${elapsed}`)}`;
    box.addChild(new Text(header, 0, 0));
    let bodyText =
      state.status === "success" || state.status === "running"
        ? (state.finalOutput ?? "")
        : (state.errorText ?? state.finalOutput ?? "");
    if (bodyText) {
      bodyText =
        bodyText.length > 80 ? `${bodyText.slice(0, 77)}...` : bodyText;
      box.addChild(new Text(theme.fg("toolOutput", bodyText), 2, 0));
    }
  }
  return box;
}
