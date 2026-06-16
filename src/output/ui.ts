import type { Message } from "@earendil-works/pi-ai";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Markdown,
  type MarkdownTheme,
  Text,
} from "@earendil-works/pi-tui";
import type { AgentScope } from "../agent/agents.js";
import {
  formatContextPercent,
  formatElapsed,
} from "../progress/progress-format.js";
import {
  type ProgressStatus,
  STATUS_BG,
  STATUS_COLOR,
  STATUS_ICON,
  type SubagentProgressState,
  type ThemeBg,
} from "../progress/progress-state.js";
import type { SubagentDetails, UsageStats } from "../shared/types.js";
import { hasSubagentFailed } from "../shared/utils.js";
import {
  extractSemanticToolTarget,
  normalizeSummaryValue,
} from "./normalize.js";

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
 * Formats the footer for subagent result cards, including model, context, turns, and cost.
 */
export function formatResultFooter(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (model) parts.push(model);
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" · ");
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
  forceJson = false,
): string {
  const target = normalizeSummaryValue(
    extractSemanticToolTarget(args, forceJson),
  );
  if (!target) return themeFg("accent", toolName);
  return themeFg("accent", toolName) + themeFg("dim", ` ${target}`);
}

export function getFinalOutput(messages: Message[]): string {
  const lastAsst = messages.findLast((m) => m.role === "assistant");
  const lastText = lastAsst?.content.findLast((p) => p.type === "text");
  return lastText?.type === "text" ? lastText.text : "";
}

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

export function renderSubagentCall(
  args: { agent?: string; task?: string; agentScope?: AgentScope },
  theme: SubagentTheme,
): Text {
  const scope: AgentScope = args.agentScope ?? "both";
  const agentName = args.agent || "...";
  // Parser-owned preview suppresses task text: show agent + scope only
  const target = args.agent ? `[${scope}]` : JSON.stringify(args);
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", agentName) +
    theme.fg("muted", ` [${scope}]`);
  text += `\n  ${theme.fg("dim", target)}`;
  return new Text(text, 0, 0, (line) => theme.bg("toolPendingBg", line));
}

export function renderSubagentToolResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  theme: SubagentTheme,
  display?: { isPartial?: boolean },
): Component {
  const details = result.details as SubagentDetails | undefined;
  if (details?.renderedByMessage) return new Text("", 0, 0);
  return renderSubagentResult(result, theme, display);
}

// Invariants: Red background = failure, green = success. Shows usage stats + duration in footer.
export function renderSubagentResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  theme: SubagentTheme,
  display?: { isPartial?: boolean },
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
  const title = formatSubagentTitle(r.agent, r.instanceName, theme);
  let effectiveBody = bodyOverride ?? finalOutput;
  if (display?.isPartial && !finalOutput?.trim() && !bodyOverride) {
    effectiveBody =
      result.content[0]?.text ||
      r.progress?.activityText ||
      r.progress?.lastToolPreview ||
      "(running...)";
  }
  const bodyText = effectiveBody;
  const toolCount = r.progress?.toolCalls?.length ?? 0;
  const toolLabel = `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
  const ctxPercent = formatContextPercent({
    contextTokens: r.usage.contextTokens,
    contextWindowTokens: r.usage.contextWindowTokens,
  });
  const metadata = `${toolLabel} · ${ctxPercent} ctx · ${formatElapsed(r.durationMs ?? 0)}`;
  const usageStr = formatResultFooter(r.usage, r.model);
  return renderStatusCard(
    {
      status: resultStatus,
      title,
      variant: "full",
      metadata,
      body: bodyText,
      footer: usageStr,
    },
    theme,
  );
}

type StatusCardVariant = "full" | "abridged";

type StatusCardOptions = {
  status: ProgressStatus;
  title: string;
  variant: StatusCardVariant;
  metadata?: string;
  body?: string;
  footer?: string;
};

function renderStatusCard(
  options: StatusCardOptions,
  theme: SubagentTheme,
): Box {
  const box = new Box(1, 1, (line) =>
    theme.bg(STATUS_BG[options.status], line),
  );
  const icon = theme.fg(
    STATUS_COLOR[options.status],
    STATUS_ICON[options.status],
  );
  const status = theme.fg("dim", `[${options.status}]`);
  const metadata = options.metadata
    ? ` ${theme.fg("muted", options.metadata)}`
    : "";
  box.addChild(new Text(`${icon} ${options.title} ${status}${metadata}`, 0, 0));
  box.addChild(makeStatusCardBody(options, theme));
  if (options.footer)
    box.addChild(new Text(theme.fg("dim", options.footer), 0, 0));
  return box;
}

function makeStatusCardBody(
  options: StatusCardOptions,
  theme: SubagentTheme,
): Box {
  const body = new Box(2, options.variant === "full" || options.footer ? 1 : 0);
  const bodyText = options.body ?? "";
  if (bodyText && options.variant === "full") {
    body.addChild(
      new Markdown(bodyText, 0, 0, makeMarkdownTheme(theme), {
        color: (text) => theme.fg("toolOutput", text),
      }),
    );
  } else if (bodyText) {
    body.addChild(new Text(theme.fg("toolOutput", bodyText), 0, 0));
  } else {
    body.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
  }
  return body;
}

const BODY_PREVIEW_MAX = 120;

function selectRunsBoardBody(state: SubagentProgressState): string {
  return (
    [state.finalOutput, state.errorText, state.taskPreview].find(
      (c): c is string => typeof c === "string" && c.trim().length > 0,
    ) ?? ""
  );
}

function renderJobCard(
  state: SubagentProgressState,
  theme: SubagentTheme,
): Box {
  const title = formatSubagentTitle(state.agent, state.instanceName, theme);
  const elapsed = formatElapsed(
    state.durationMs ?? Date.now() - state.startTime,
  );
  const ctxPercent = formatContextPercent(state);
  const toolLabel = state.toolCount === 1 ? "tool" : "tools";
  const metadata = `${state.toolCount} ${toolLabel} · ${ctxPercent} ctx · ${elapsed}`;
  const bodyText = selectRunsBoardBody(state);
  const preview =
    bodyText.length > BODY_PREVIEW_MAX
      ? `${bodyText.slice(0, BODY_PREVIEW_MAX - 1)}…`
      : bodyText;
  const options: StatusCardOptions = {
    status: state.status,
    title,
    variant: "abridged",
    metadata,
    body: preview,
  };
  if (state.modelDisplay) options.footer = state.modelDisplay;
  return renderStatusCard(options, theme);
}

function sortByStartTimeDesc(
  a: SubagentProgressState,
  b: SubagentProgressState,
): number {
  return b.startTime - a.startTime;
}

/** Ordered section definitions: label → status filter for the runs board. */
const BOARD_SECTIONS: [string, ProgressStatus][] = [
  ["ACTIVE", "running"],
  ["FAILED", "error"],
  ["CANCELLED", "cancelled"],
  ["SUCCEEDED", "success"],
];

// Jobs render in status-specific sections, each sorted by `startTime` descending.
// Status icons preserve the existing /jobs contract for running and cancelled jobs.
export function renderRunsBoard(
  states: SubagentProgressState[],
  theme: SubagentTheme,
  width = 80,
): Component {
  if (states.length === 0) {
    return new Text(theme.fg("muted", "No /run jobs in this session."), 0, 0);
  }
  const grouped = new Map<ProgressStatus, SubagentProgressState[]>();
  for (const s of states) {
    const bucket = grouped.get(s.status);
    if (bucket) bucket.push(s);
    else grouped.set(s.status, [s]);
  }
  for (const bucket of grouped.values()) bucket.sort(sortByStartTimeDesc);
  const box = new Box(0, 0);
  const addSection = (
    label: string,
    sectionStates: SubagentProgressState[],
  ) => {
    if (sectionStates.length === 0) return;
    const sectionHeader = `${label} (${sectionStates.length})`;
    const ruler = "─".repeat(Math.max(0, width - sectionHeader.length - 1));
    box.addChild(new Text(theme.fg("dim", `${sectionHeader} ${ruler}`), 0, 0));
    for (const state of sectionStates)
      box.addChild(renderJobCard(state, theme));
  };
  for (const [label, status] of BOARD_SECTIONS)
    addSection(label, grouped.get(status) ?? []);
  return box;
}
