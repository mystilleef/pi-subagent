import { describe, expect, test } from "bun:test";
import {
  makeMarkdownTheme,
  style,
  styleBackground,
  styleStatusGlyph,
  styleTally,
} from "../src/output/semantic-style.js";
import {
  type ProgressStatus,
  STATUS_BG,
  STATUS_COLOR,
  STATUS_ICON,
} from "../src/progress/progress-state.js";
import { createDefaultFakeTheme } from "./fixtures.js";

const STATUSES: readonly ProgressStatus[] = [
  "running",
  "success",
  "error",
  "cancelled",
];

const theme = createDefaultFakeTheme();

describe("style", () => {
  test.each([
    { role: "agent", expected: "[toolTitle]*build*[/toolTitle]" },
    { role: "instance", expected: "[accent]_build_[/accent]" },
    { role: "metadata", expected: "[dim]build[/dim]" },
  ] as const)(
    "applies $role modifiers inside its color",
    ({ role, expected }) => {
      expect(style(theme, role, "build")).toBe(expected);
    },
  );
});

describe("status-driven styles", () => {
  test.each(STATUSES)("colors the %s glyph with its status color", (status) => {
    expect(styleStatusGlyph(theme, status)).toBe(
      `[${STATUS_COLOR[status]}]${STATUS_ICON[status]}[/${STATUS_COLOR[status]}]`,
    );
  });

  test.each(STATUSES)("paints the %s background", (status) => {
    expect(styleBackground(theme, status, "line")).toBe(
      `[${STATUS_BG[status]}]line[/${STATUS_BG[status]}]`,
    );
  });
});

describe("styleTally", () => {
  test("styles a delimiter-free tally as one muted segment", () => {
    expect(styleTally(theme, "2 spawned")).toBe("[muted]2 spawned[/muted]");
  });

  test("joins muted segments with dim delimiters", () => {
    expect(styleTally(theme, "2 spawned · 1 running")).toBe(
      "[muted]2 spawned[/muted][dim] · [/dim][muted]1 running[/muted]",
    );
  });
});

describe("makeMarkdownTheme", () => {
  const md = makeMarkdownTheme(theme);

  test.each([
    { role: "heading", color: "mdHeading" },
    { role: "link", color: "mdLink" },
    { role: "linkUrl", color: "mdLinkUrl" },
    { role: "code", color: "mdCode" },
    { role: "codeBlock", color: "mdCodeBlock" },
    { role: "codeBlockBorder", color: "mdCodeBlockBorder" },
    { role: "quote", color: "mdQuote" },
    { role: "quoteBorder", color: "mdQuoteBorder" },
    { role: "hr", color: "mdHr" },
    { role: "listBullet", color: "mdListBullet" },
  ] as const)("maps the $role role to the $color color", ({ role, color }) => {
    expect(md[role]("x")).toBe(`[${color}]x[/${color}]`);
  });

  test("delegates bold italic strikethrough and underline to theme modifiers", () => {
    expect(md.bold("x")).toBe("*x*");
    expect(md.italic("x")).toBe("_x_");
    expect(md.strikethrough("x")).toBe("~x~");
    expect(md.underline("x")).toBe("__x__");
  });
});
