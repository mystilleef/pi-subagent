import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Text } from "@earendil-works/pi-tui";
import type { AgentScope } from "../agent/agents.js";
import {
  clipDisplayPieces,
  type DisplayPiece,
} from "../progress/display-pieces.js";
import {
  type DescendantTallyOptions,
  type FormatUsageTreeOptions,
  formatActivityStats,
  formatCost,
  formatDescendantTally,
  formatDisplayIdentity,
  formatUsageTreePieces,
  hasDescendants,
  SEGMENT_SEPARATOR,
} from "../progress/progress-format.js";
import type { ProgressStatus } from "../progress/progress-state.js";
import type {
  SubagentDetails,
  UsageInstanceNode,
  UsageStats,
} from "../shared/types.js";
import { firstValidOrdinal } from "../shared/usage-validation.js";
import { hasSubagentFailed } from "../shared/utils.js";
import {
  makeMarkdownTheme,
  type SubagentTheme,
  style,
  styleBackground,
  stylePieces,
  styleStatusGlyph,
  styleTally,
} from "./semantic-style.js";

export type { SubagentTheme };

/** Themed card title; segment order follows {@link formatDisplayIdentity}. */
export function formatSubagentTitle(
  agent: string,
  instanceName: string | undefined,
  theme: SubagentTheme,
  ordinal?: number,
): string {
  return formatDisplayIdentity(
    style(theme, "agent", agent),
    instanceName && style(theme, "instance", instanceName),
    ordinal,
    (text) => style(theme, "ordinal", text),
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

export { extractFinalOutputFromMessages as getFinalOutput } from "../shared/utils.js";

export function renderSubagentCall(
  args: { agent?: string; task?: string; agentScope?: AgentScope },
  theme: SubagentTheme,
): Text {
  const scope: AgentScope = args.agentScope ?? "both";
  const identity = args.agent
    ? style(theme, "callIdentity", args.agent)
    : style(theme, "callPlaceholder", "...");
  let text =
    style(theme, "callIdentity", "subagent ") +
    identity +
    style(theme, "callScope", ` [${scope}]`);
  // A named call already shows its scope; only an unnamed one needs raw
  // arguments. Parser-owned previews never include task text.
  if (!args.agent)
    text += `\n  ${style(theme, "callArgs", JSON.stringify(args))}`;
  return new Text(text, 0, 0, (line) =>
    styleBackground(theme, "running", line),
  );
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
    return new Text(styleTally(this.theme, tally), CARD_BODY_INDENT, 0).render(
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

/**
 * Tree rows end-clipped to the render width, one line each, so deep rows
 * never wrap past their indent. Lines are cached per width: pi-tui `Box`
 * compares child lines by identity each frame.
 */
class UsageTree implements Component {
  private readonly rows: readonly DisplayPiece[][];
  private readonly theme: SubagentTheme;
  private cache: { width: number; lines: string[] } | undefined;
  constructor(rows: readonly DisplayPiece[][], theme: SubagentTheme) {
    this.rows = rows;
    this.theme = theme;
  }
  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.cache?.width !== width)
      this.cache = {
        width,
        lines: this.rows.map((row) =>
          stylePieces(this.theme, clipDisplayPieces(row, width)),
        ),
      };
    return this.cache.lines;
  }
  invalidate(): void {
    this.cache = undefined;
  }
}

/**
 * Width-fitted usage tree; rows and running durations snapshot at
 * creation. Undefined when the tree renders no rows.
 */
export function createUsageTree(
  tree: UsageInstanceNode | undefined,
  theme: SubagentTheme,
  options?: FormatUsageTreeOptions,
): Component | undefined {
  if (!tree) return undefined;
  const rows = formatUsageTreePieces(tree, options);
  return rows.length > 0 ? new UsageTree(rows, theme) : undefined;
}

/** Status icon, title, and bracketed status shared by every card header. */
function formatStatusHeader(
  status: ProgressStatus,
  title: string,
  theme: SubagentTheme,
): string {
  const icon = styleStatusGlyph(theme, status);
  return `${icon} ${title} ${style(theme, "statusLabel", `[${status}]`)}`;
}

/** Padded card container with the status background. */
function makeStatusBox(status: ProgressStatus, theme: SubagentTheme): Box {
  return new Box(1, 1, (line) => styleBackground(theme, status, line));
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
    new Text(`${header} ${style(theme, "metadata", anatomy.metadata)}`, 0, 0),
  );
  for (const block of anatomy.blocks) {
    if (block) box.addChild(withLayoutGap(block));
  }
  if (anatomy.footer)
    box.addChild(
      withLayoutGap(new Text(style(theme, "footer", anatomy.footer), 0, 0)),
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

export type StatusCardOptions = {
  status: ProgressStatus;
  title: string;
  metadata: string;
  /**
   * Markdown (result cards) or one pre-fitted piece line (`/jobs`);
   * empty renders `(no output)`.
   */
  body?: string | readonly DisplayPiece[];
  footer?: string;
  tally?: Component;
};

export function renderStatusCard(
  options: StatusCardOptions,
  theme: SubagentTheme,
): Box {
  return renderCard(
    {
      status: options.status,
      title: options.title,
      metadata: options.metadata,
      blocks: [makeStatusCardBody(options.body, theme), options.tally],
      footer: options.footer,
    },
    theme,
  );
}

function makeStatusCardBody(
  body: StatusCardOptions["body"],
  theme: SubagentTheme,
): Box {
  const box = new Box(CARD_BODY_INDENT, 0);
  if (!body?.length)
    box.addChild(new Text(style(theme, "boardText", "(no output)"), 0, 0));
  else if (typeof body === "string")
    box.addChild(
      new Markdown(body, 0, 0, makeMarkdownTheme(theme), {
        color: (text) => style(theme, "output", text),
      }),
    );
  else box.addChild(new Text(stylePieces(theme, body), 0, 0));
  return box;
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
    `${style(theme, "heading", heading)} ${style(theme, "ruler", ruler)}`,
    0,
    0,
  );
}

/** Board header: bold `Session` label, then totals in board tone. */
export function formatSessionHeader(
  theme: SubagentTheme,
  ...totals: string[]
): string {
  return `${style(theme, "heading", "Session")}${style(theme, "boardText", `${SEGMENT_SEPARATOR}${joinSegments(...totals)}`)}`;
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
