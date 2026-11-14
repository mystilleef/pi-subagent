/**
 * Display-only projection of a ToolActivity chain into role-tagged pieces
 * for the live activity row. Shortens paths against the pi process working
 * directory and home; stored activity text stays in `progress-format.js`.
 */

import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { normalizeSummaryValue } from "../output/normalize.js";
import type { ToolActivity } from "../shared/types.js";
import {
  type ActivityDisplayPiece,
  identityPieces,
  REDACTED_PLACEHOLDER,
  SENSITIVE_PATTERN,
  SPACE,
} from "./progress-format.js";

const HIDDEN_TEXT = "(hidden)";
const THINKING_TEXT = "thinking";
const ACTIVITY_MARK = "›";
const ELLIPSIS = "…";

/** Innermost named delegate; `depth` counts hops from the root's tool. */
interface Delegate {
  agent: string;
  instanceName?: string | undefined;
  ordinal?: number | undefined;
  depth: number;
}

type ActivityDisplay =
  | { kind: "hidden" }
  | { kind: "thinking"; delegate?: Delegate | undefined }
  | {
      kind: "tool";
      delegate?: Delegate | undefined;
      tool: string;
      target?: string | undefined;
    };

const SEPARATOR: readonly ActivityDisplayPiece[] = [
  SPACE,
  { role: "mark", text: ACTIVITY_MARK },
  SPACE,
];

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function piecesWidth(pieces: readonly ActivityDisplayPiece[]): number {
  return pieces.reduce((count, piece) => count + visibleWidth(piece.text), 0);
}

function headClip(text: string, maxWidth: number): string {
  let result = "";
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const w = visibleWidth(segment);
    if (width + w > maxWidth) break;
    result += segment;
    width += w;
  }
  return result;
}

function tailClip(text: string, maxWidth: number): string {
  const segments = [...graphemeSegmenter.segment(text)];
  let result = "";
  let width = 0;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i]?.segment ?? "";
    const w = visibleWidth(segment);
    if (width + w > maxWidth) break;
    result = segment + result;
    width += w;
  }
  return result;
}

/** A deleted working directory or missing home throws; shortening skips it. */
function readDirectory(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}

/** `target` relative to `base`, or undefined when it resolves outside. */
function pathWithin(base: string, target: string): string | undefined {
  const relative = path.posix.relative(base, target);
  return relative === ".." || relative.startsWith("../") ? undefined : relative;
}

/** Directories anchoring path shortening; either read may throw. */
export interface PathAnchors {
  readonly cwd: () => string;
  readonly home: () => string;
}

/** The pi process's own directories, read only when a path needs them. */
const PROCESS_PATH_ANCHORS: PathAnchors = {
  cwd: () => process.cwd(),
  // `HOME` first matches Node's `os.homedir()`; Bun ignores runtime changes.
  home: () => process.env["HOME"] || os.homedir(),
};

/**
 * Shortens a single-token absolute path: relative inside the anchored
 * working directory, `~`-based under home, else unchanged.
 */
function shortenPath(target: string, anchors: PathAnchors): string {
  if (!target.startsWith("/") || /\s/.test(target)) return target;
  const cwd = readDirectory(anchors.cwd);
  const inCwd = cwd ? pathWithin(cwd, target) : undefined;
  if (inCwd !== undefined) return inCwd || ".";
  const home = readDirectory(anchors.home);
  const inHome = home ? pathWithin(home, target) : undefined;
  if (inHome !== undefined) return inHome ? `~/${inHome}` : "~";
  return target;
}

/** Cuts the line at its end, keeping each surviving piece's role. */
function clipActivityPieces(
  pieces: readonly ActivityDisplayPiece[],
  maxChars: number,
): ActivityDisplayPiece[] {
  if (piecesWidth(pieces) <= maxChars) return [...pieces];
  const boundary = maxChars - 1;
  const clipped: ActivityDisplayPiece[] = [];
  let consumed = 0;
  for (const piece of pieces) {
    const w = visibleWidth(piece.text);
    if (consumed + w > boundary) {
      const room = Math.max(0, boundary - consumed);
      clipped.push({
        role: piece.role,
        text: `${headClip(piece.text, room)}${ELLIPSIS}`,
      });
      break;
    }
    clipped.push(piece);
    consumed += w;
  }
  return clipped;
}

/**
 * Shortens the target to fit (paths keep their tail, other text its
 * head), else drops it. The sensitive test sees the full target before
 * any shortening.
 */
function fitTarget(
  prefix: ActivityDisplayPiece[],
  target: string | undefined,
  maxChars: number,
  anchors: PathAnchors,
): ActivityDisplayPiece[] {
  if (target === undefined) return prefix;
  const room = maxChars - piecesWidth(prefix) - 1; // space before the target
  if (SENSITIVE_PATTERN.test(target)) {
    if (visibleWidth(HIDDEN_TEXT) > room) return prefix;
    return [...prefix, SPACE, { role: "inferred", text: HIDDEN_TEXT }];
  }
  const shown = shortenPath(target, anchors);
  if (visibleWidth(shown) <= room)
    return [...prefix, { role: "target", text: ` ${shown}` }];
  const clipWidth = room - 1; // the ellipsis
  if (clipWidth <= 0) return prefix;
  const isPath = !/\s/.test(shown) && shown.includes("/");
  const clipped = isPath
    ? `${ELLIPSIS}${tailClip(shown, clipWidth)}`
    : `${headClip(shown, clipWidth)}${ELLIPSIS}`;
  return [...prefix, { role: "target", text: ` ${clipped}` }];
}

/** `… › ` below the root's direct child, then `<identity> › `. */
function leadPieces(delegate: Delegate | undefined): ActivityDisplayPiece[] {
  if (!delegate) return [];
  const hint: ActivityDisplayPiece[] =
    delegate.depth > 0 ? [{ role: "mark", text: ELLIPSIS }, ...SEPARATOR] : [];
  return [
    ...hint,
    ...identityPieces(delegate.agent, delegate.instanceName, delegate.ordinal),
    ...SEPARATOR,
  ];
}

/**
 * Projects a ToolActivity chain into role-tagged display pieces within a
 * visible-width budget: `[… › ][<identity> › ]<action>`, where `<action>`
 * reads `<tool>[ <target>]` or `thinking` while no tool runs. Stored text
 * stays untouched. Overflow shortens the target, then drops it, then cuts
 * the whole line. Path targets shorten against `anchors`, the pi process
 * directories by default.
 */
export function renderToolActivityPieces(
  activity: ToolActivity | undefined,
  maxChars: number,
  anchors: PathAnchors = PROCESS_PATH_ANCHORS,
): ActivityDisplayPiece[] {
  if (maxChars <= 0) return [];
  const described = describeActivity(activity);
  if (described.kind === "hidden")
    return clipActivityPieces(
      [{ role: "inferred", text: HIDDEN_TEXT }],
      maxChars,
    );
  const lead = leadPieces(described.delegate);
  if (described.kind === "thinking")
    return clipActivityPieces(
      [...lead, { role: "inferred", text: THINKING_TEXT }],
      maxChars,
    );
  const prefix: ActivityDisplayPiece[] = [
    ...lead,
    { role: "tool", text: described.tool },
  ];
  return clipActivityPieces(
    fitTarget(prefix, described.target, maxChars, anchors),
    maxChars,
  );
}

function parseSubagentAgentName(inputSummary?: string): string | undefined {
  const match = inputSummary?.match(/^subagent:\s*(\S+)/);
  return match?.[1];
}

function toolWithTarget(
  tool: string,
  target: string,
): { tool: string; target?: string | undefined } {
  return target.trim() ? { tool, target } : { tool };
}

/**
 * Leaf tool and target, split at the summary's first `": "`. Flattened
 * hops (`tool`) carry pre-joined text whose head names the tool; a parent
 * stripped of its child keeps the child's summary, so only the remainder
 * counts as target. Unnamed delegations render as the bare tool.
 */
function parseLeafAction({ toolName, inputSummary }: ToolActivity): {
  tool: string;
  target?: string | undefined;
} {
  if (toolName === "subagent" || !inputSummary || inputSummary === toolName)
    return { tool: toolName };
  const index = inputSummary.indexOf(": ");
  const remainder = index === -1 ? inputSummary : inputSummary.slice(index + 2);
  if (toolName !== "tool") return toolWithTarget(toolName, remainder);
  if (index <= 0) return { tool: inputSummary };
  return toolWithTarget(inputSummary.slice(0, index), remainder);
}

/** Reduces a chain to its innermost named delegate and leaf action. */
function describeActivity(activity: ToolActivity | undefined): ActivityDisplay {
  if (!activity) return { kind: "thinking" };
  let leaf = activity;
  let leafDepth = 0;
  let delegate: Delegate | undefined;
  for (
    let node: ToolActivity | undefined = activity, depth = 0;
    node;
    node = node.child, depth += 1
  ) {
    leaf = node;
    leafDepth = depth;
    const agent =
      node.toolName === "subagent"
        ? parseSubagentAgentName(node.inputSummary)
        : undefined;
    if (agent)
      delegate = {
        agent,
        instanceName: node.instanceName,
        ordinal: node.ordinal,
        depth,
      };
  }
  const raw = leaf.inputSummary ?? leaf.toolName;
  if (raw === REDACTED_PLACEHOLDER) return { kind: "hidden" };
  if (
    leaf.toolName === "tool" &&
    !raw.includes(": ") &&
    SENSITIVE_PATTERN.test(raw)
  )
    return { kind: "hidden" };
  if (delegate?.depth === leafDepth) return { kind: "thinking", delegate };
  const action = parseLeafAction(leaf);
  const target =
    action.target === undefined
      ? undefined
      : normalizeSummaryValue(action.target) || undefined;
  return {
    kind: "tool",
    delegate,
    tool: normalizeSummaryValue(action.tool) || leaf.toolName,
    target,
  };
}
