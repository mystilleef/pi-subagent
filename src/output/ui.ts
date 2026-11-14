import type {
  ExtensionCommandContext,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Markdown,
  type MarkdownTheme,
  Text,
} from "@earendil-works/pi-tui";
import type { AgentScope } from "../agent/agents.js";
import {
  type DescendantTallyOptions,
  formatActivityStats,
  formatCost,
  formatDescendantTally,
  formatDisplayIdentity,
  formatHeaderStats,
  hasDescendants,
  SEGMENT_SEPARATOR,
} from "../progress/progress-format.js";
import {
  type ProgressStatus,
  STATUS_BG,
  STATUS_COLOR,
  STATUS_ICON,
  type SubagentProgressState,
  type ThemeBg,
} from "../progress/progress-state.js";
import type {
  SessionUsageQueryResult,
  SubagentDetails,
  UsageInstanceNode,
  UsageStats,
} from "../shared/types.js";
import { firstValidOrdinal } from "../shared/usage-validation.js";
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

/** Themed card title; segment order follows {@link formatDisplayIdentity}. */
export function formatSubagentTitle(
  agent: string,
  instanceName: string | undefined,
  theme: SubagentTheme,
  ordinal?: number,
): string {
  return formatDisplayIdentity(
    theme.fg("toolTitle", theme.bold(agent)),
    instanceName && theme.fg("accent", italicText(instanceName, theme)),
    ordinal,
    (text) => theme.fg("accent", text),
  );
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function joinSegments(...segments: (string | undefined)[]): string {
  return segments.filter(Boolean).join(SEGMENT_SEPARATOR);
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
 * Formats the plural-aware turn count string.
 */
function formatTurns(turns: number): string {
  return `${turns} turn${turns > 1 ? "s" : ""}`;
}

function formatIoTokens(input: number, output: number): string {
  const tokens: string[] = [];
  if (input) tokens.push(`↑${formatTokens(input)}`);
  if (output) tokens.push(`↓${formatTokens(output)}`);
  return tokens.join(" ");
}

function formatCacheStats(cacheRead: number, cacheWrite: number): string {
  const cache: string[] = [];
  if (cacheRead) cache.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite) cache.push(`W${formatTokens(cacheWrite)}`);
  return `cache:${cache.join("/")}`;
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
  if (usage.turns) parts.push(formatTurns(usage.turns));
  if (usage.input || usage.output)
    parts.push(formatIoTokens(usage.input, usage.output));
  if (!compact && (usage.cacheRead || usage.cacheWrite))
    parts.push(formatCacheStats(usage.cacheRead, usage.cacheWrite));
  if (!compact && usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (usage.cost) parts.push(formatCost(usage.cost));
  if (model) parts.push(model);
  return parts.join(SEGMENT_SEPARATOR);
}

/**
 * Formats the footer for subagent result cards: model, turns, and self-only cost.
 * Omits context tokens, since header `% ctx` is the sole context figure, and
 * run segments, which belong to the tally.
 */
export function formatResultFooter(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (model) parts.push(model);
  if (usage.turns) parts.push(formatTurns(usage.turns));
  if (usage.cost) parts.push(formatCost(usage.cost));
  return parts.join(SEGMENT_SEPARATOR);
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

export { extractFinalOutputFromMessages as getFinalOutput } from "../shared/utils.js";

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
  const finalOutput = r.finalOutput ?? "";
  const title = formatSubagentTitle(
    r.agent,
    r.instanceName,
    theme,
    firstValidOrdinal(r.ordinal, details?.usageTree?.ordinal),
  );
  let effectiveBody = bodyOverride ?? finalOutput;
  if (display?.isPartial && !finalOutput?.trim() && !bodyOverride) {
    effectiveBody =
      result.content[0]?.text ||
      r.progress?.activityText ||
      r.progress?.lastToolPreview ||
      "(running...)";
  }
  const bodyText = effectiveBody.trim();
  const metadata = formatActivityStats(
    r.progress?.toolCalls?.length ?? 0,
    r.usage,
    r.durationMs ?? 0,
  );
  const tally = createDescendantTally(details?.usageTree, theme);
  return renderStatusCard(
    {
      status: resultStatus,
      title,
      variant: "full",
      metadata,
      body: bodyText,
      footer: formatResultFooter(r.usage, r.model),
      ...(tally !== undefined ? { tally } : {}),
    },
    theme,
  );
}

/** Column of every card block between header and footer. */
export const CARD_BODY_INDENT = 2;

// Fits the tally at render time: only then does the host supply the width.
class DescendantTally implements Component {
  private readonly tree: UsageInstanceNode;
  private readonly theme: SubagentTheme;
  private readonly options: DescendantTallyOptions | undefined;
  constructor(
    tree: UsageInstanceNode,
    theme: SubagentTheme,
    options: DescendantTallyOptions | undefined,
  ) {
    this.tree = tree;
    this.theme = theme;
    this.options = options;
  }
  render(width: number): string[] {
    const tally = formatDescendantTally(
      this.tree,
      width - 2 * CARD_BODY_INDENT,
      this.options,
    );
    if (!tally) return [];
    return new Text(this.theme.fg("muted", tally), CARD_BODY_INDENT, 0).render(
      width,
    );
  }
  invalidate(): void {}
}

/** Width-fitted descendant tally line at column 2; undefined for leaves. */
export function createDescendantTally(
  tree: UsageInstanceNode | undefined,
  theme: SubagentTheme,
  options?: DescendantTallyOptions,
): Component | undefined {
  if (!tree || !hasDescendants(tree)) return undefined;
  return new DescendantTally(tree, theme, options);
}

/** Status icon, title, and bracketed status shared by every card header. */
function formatStatusHeader(
  status: ProgressStatus,
  title: string,
  theme: SubagentTheme,
): string {
  const icon = theme.fg(STATUS_COLOR[status], STATUS_ICON[status]);
  return `${icon} ${title} ${theme.fg("muted", `[${status}]`)}`;
}

/** Padded card container with the status background. */
function makeStatusBox(status: ProgressStatus, theme: SubagentTheme): Box {
  return new Box(1, 1, (line) => theme.bg(STATUS_BG[status], line));
}

/** Content of one card; layout and spacing belong to {@link renderCard}. */
export type CardAnatomy = {
  status: ProgressStatus;
  title: string;
  metadata: string;
  /** Ordered blocks between header and footer; absent entries are skipped. */
  blocks: readonly (Component | undefined)[];
  footer?: string | undefined;
};

/**
 * Assembles every status card: header, present blocks, then footer, with
 * one blank row between consecutive rendered blocks.
 */
export function renderCard(anatomy: CardAnatomy, theme: SubagentTheme): Box {
  const box = makeStatusBox(anatomy.status, theme);
  const header = formatStatusHeader(anatomy.status, anatomy.title, theme);
  box.addChild(
    new Text(`${header} ${theme.fg("muted", anatomy.metadata)}`, 0, 0),
  );
  for (const block of anatomy.blocks) {
    if (block) box.addChild(withLayoutGap(block));
  }
  if (anatomy.footer)
    box.addChild(
      withLayoutGap(new Text(theme.fg("muted", anatomy.footer), 0, 0)),
    );
  return box;
}

/**
 * Wraps a present block with its preceding layout blank row.
 * Returns no lines when the inner block renders nothing, so a
 * suppressed tally leaves no orphan spacer.
 */
export function withLayoutGap(inner: Component): Component {
  return {
    render(width: number): string[] {
      const lines = inner.render(width);
      if (lines.length === 0) return [];
      return ["", ...lines];
    },
    invalidate(): void {
      inner.invalidate();
    },
  };
}

type StatusCardVariant = "full" | "abridged";

type StatusCardOptions = {
  status: ProgressStatus;
  title: string;
  variant: StatusCardVariant;
  metadata: string;
  body?: string;
  footer?: string;
  tally?: Component;
};

function renderStatusCard(
  options: StatusCardOptions,
  theme: SubagentTheme,
): Box {
  return renderCard(
    {
      status: options.status,
      title: options.title,
      metadata: options.metadata,
      blocks: [makeStatusCardBody(options, theme), options.tally],
      footer: options.footer,
    },
    theme,
  );
}

function makeStatusCardBody(
  options: StatusCardOptions,
  theme: SubagentTheme,
): Box {
  const body = new Box(CARD_BODY_INDENT, 0);
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
  usageInstance?: UsageInstanceNode,
): Box {
  const title = formatSubagentTitle(
    state.agent,
    state.instanceName,
    theme,
    state.ordinal,
  );
  const bodyText = selectRunsBoardBody(state);
  const preview =
    bodyText.length > BODY_PREVIEW_MAX
      ? `${bodyText.slice(0, BODY_PREVIEW_MAX - 1)}…`
      : bodyText;
  const options: StatusCardOptions = {
    status: state.status,
    title,
    variant: "abridged",
    metadata: formatHeaderStats(state),
    body: preview,
  };
  const tally = createDescendantTally(usageInstance, theme);
  if (tally) options.tally = tally;
  if (state.modelDisplay) options.footer = state.modelDisplay;
  return renderStatusCard(options, theme);
}

export function makeSectionHeader(
  label: string,
  count: number,
  width: number,
  theme: SubagentTheme,
): Text {
  const heading = `${label} (${count})`;
  const ruler = "─".repeat(Math.max(0, width - heading.length - 1));
  return new Text(
    `${theme.fg("muted", heading)} ${theme.fg("dim", ruler)}`,
    0,
    0,
  );
}

/** Ledger data the `/jobs` board renders beside progress state. */
export interface RunsBoardUsage {
  session: SessionUsageQueryResult;
  /** Ledger subtree per job `requestId`; jobs without one show no run cost. */
  instances: ReadonlyMap<string, UsageInstanceNode>;
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
  usage?: RunsBoardUsage,
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
  if (usage) {
    const { runs, rollup } = usage.session;
    const header = joinSegments(
      "Session",
      plural(runs.length, "run"),
      plural(rollup.instances, "instance"),
      formatCost(rollup.usage.cost),
    );
    box.addChild(new Text(theme.fg("muted", header), 0, 0));
  }
  const addSection = (
    label: string,
    sectionStates: SubagentProgressState[],
  ) => {
    if (sectionStates.length === 0) return;
    box.addChild(makeSectionHeader(label, sectionStates.length, width, theme));
    for (const state of sectionStates)
      box.addChild(
        renderJobCard(state, theme, usage?.instances.get(state.requestId)),
      );
  };
  for (const [label, status] of BOARD_SECTIONS)
    addSection(label, grouped.get(status) ?? []);
  return box;
}

/**
 * Shows a board, then notifies its text rendered two columns narrower so
 * notification padding never wraps background bars.
 */
export async function notifyBoard(
  ctx: ExtensionCommandContext,
  build: (theme: SubagentTheme, width: number) => Component,
): Promise<void> {
  const output = await ctx.ui.custom<string>(
    (_tui, theme, _keybindings, done) => ({
      invalidate() {},
      render(width) {
        const tuiLines = build(theme, width).render(width);
        const notifyWidth = Math.max(1, width - 2);
        done(build(theme, notifyWidth).render(notifyWidth).join("\n"));
        return tuiLines;
      },
    }),
  );
  ctx.ui.notify(output);
}
