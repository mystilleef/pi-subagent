/**
 * Role-tagged display pieces and width fitting shared by activity, tree,
 * and job surfaces. A dependency-free leaf, so progress projections and
 * output styling both import it without coupling to each other.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Role of one display piece on activity, tree, and job surfaces. Every
 * role except `plain` names a semantic style, so literal `\u2026`, `\u203a`, or
 * `(hidden)` text inside a tool or target never takes another piece's
 * role.
 */
export type DisplayPieceRole =
  | "plain"
  | "mark"
  | "agent"
  | "ordinal"
  | "instance"
  | "tool"
  | "target"
  | "inferred"
  | "tally"
  | "tallyDelimiter"
  | "metadata"
  | "output"
  | "error"
  | "taskLabel"
  | "taskPreview";

/** Ordered `{ role, text }` segment with source-derived roles. */
export interface DisplayPiece {
  role: DisplayPieceRole;
  text: string;
}

export const SPACE: DisplayPiece = { role: "plain", text: " " };

export const ELLIPSIS = "\u2026";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Visible columns of the joined pieces. */
export function piecesWidth(pieces: readonly DisplayPiece[]): number {
  return pieces.reduce((count, piece) => count + visibleWidth(piece.text), 0);
}

/** Leading whole graphemes fitting `maxWidth` columns. */
export function headClip(text: string, maxWidth: number): string {
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

/** Trailing whole graphemes fitting `maxWidth` columns. */
export function tailClip(text: string, maxWidth: number): string {
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

/**
 * Fits pieces to `maxWidth` columns; `[]` at nonpositive widths. Overflow
 * keeps leading pieces, cuts the boundary piece at a grapheme boundary,
 * and appends `\u2026` in its role, so trailing segments drop first and
 * surviving roles never change.
 */
export function clipDisplayPieces(
  pieces: readonly DisplayPiece[],
  maxWidth: number,
): DisplayPiece[] {
  if (maxWidth <= 0) return [];
  if (piecesWidth(pieces) <= maxWidth) return [...pieces];
  const boundary = maxWidth - visibleWidth(ELLIPSIS);
  const clipped: DisplayPiece[] = [];
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
