import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { SEGMENT_SEPARATOR } from "../progress/progress-format.js";
import {
  type ProgressStatus,
  STATUS_BG,
  STATUS_COLOR,
  STATUS_ICON,
} from "../progress/progress-state.js";

/** Pi's `Theme` narrowed to the methods subagent renderers call. */
export type SubagentTheme = Pick<
  Theme,
  "fg" | "bg" | "bold" | "italic" | "underline" | "strikethrough"
>;

interface RoleStyle {
  color: ThemeColor;
  bold?: true;
  italic?: true;
}

/**
 * Single source of every card, board, activity, and tool-call style.
 * Roles sharing a style stay separate so each restyles with one edit.
 */
const ROLE_STYLES = {
  agent: { color: "toolTitle", bold: true },
  ordinal: { color: "dim" },
  instance: { color: "accent", italic: true },
  statusLabel: { color: "muted" },
  metadata: { color: "dim" },
  footer: { color: "dim" },
  mark: { color: "dim" },
  tool: { color: "text", bold: true },
  target: { color: "dim" },
  inferred: { color: "dim", italic: true },
  taskLabel: { color: "muted", bold: true },
  taskPreview: { color: "muted", italic: true },
  heading: { color: "muted", bold: true },
  ruler: { color: "dim" },
  boardText: { color: "muted" },
  callIdentity: { color: "toolTitle", bold: true },
  callPlaceholder: { color: "accent" },
  callScope: { color: "muted" },
  callArgs: { color: "dim" },
  tally: { color: "muted" },
  tallyDelimiter: { color: "dim" },
  output: { color: "toolOutput" },
  error: { color: "error" },
} as const satisfies Record<string, RoleStyle>;

export type StyleRole = keyof typeof ROLE_STYLES;

/** Styles text by semantic role: modifiers inside, theme color outside. */
export function style(
  theme: SubagentTheme,
  role: StyleRole,
  text: string,
): string {
  const spec: RoleStyle = ROLE_STYLES[role];
  const weighted = spec.bold ? theme.bold(text) : text;
  return theme.fg(spec.color, spec.italic ? theme.italic(weighted) : weighted);
}

/** Status glyph in its status color. */
export function styleStatusGlyph(
  theme: SubagentTheme,
  status: ProgressStatus,
): string {
  return theme.fg(STATUS_COLOR[status], STATUS_ICON[status]);
}

/** Card background line for a status. */
export function styleBackground(
  theme: SubagentTheme,
  status: ProgressStatus,
  line: string,
): string {
  return theme.bg(STATUS_BG[status], line);
}

/** Width-fitted plain tally: `tally` segments joined by `tallyDelimiter`. */
export function styleTally(theme: SubagentTheme, tally: string): string {
  return tally
    .split(SEGMENT_SEPARATOR)
    .map((segment) => style(theme, "tally", segment))
    .join(style(theme, "tallyDelimiter", SEGMENT_SEPARATOR));
}

/** Result markdown theme built from pi's own modifiers. */
export function makeMarkdownTheme(theme: SubagentTheme): MarkdownTheme {
  const fg = (color: ThemeColor) => (text: string) => theme.fg(color, text);
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
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}
