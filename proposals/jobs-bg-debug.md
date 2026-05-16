# `/jobs` card background rendering — troubleshooting notes

## Symptom

Gray bars appear on the right edge of every job card in the `/jobs` board.
Progress and result cards (inline TUI renderers) render backgrounds correctly.

## Root architectural difference

| Card type | Render path |
|-----------|-------------|
| Progress/result | `pi.registerMessageRenderer` / `renderTool` → live TUI component, `render(width)` called by TUI loop with correct panel width each tick |
| `/jobs` board | `ctx.ui.custom` → `render(panelWidth)` called once → `done(lines.join("\n"))` → `ctx.ui.notify(output)` |

The jobs board is the only path that goes through `notify`. That is the most likely source of the discrepancy.

## Hypothesis 1 — width mismatch (tested, not fixed)

`ctx.ui.custom` passes the panel width W to `render(width)`.
`ctx.ui.notify(output)` displays at terminal width T.
If W < T, the background covers only W columns and the rightmost (T − W) columns show the terminal default.

**Fix attempted:** `src/jobs-command.ts` now uses `process.stdout.columns ?? width` as `renderWidth`.

```typescript
render(width) {
  const renderWidth = process.stdout.columns ?? width;
  const lines = renderRunsBoard(all, theme, renderWidth).render(renderWidth);
  done(lines.join("\n"));
  return lines;
},
```

**Result:** User reports issue persists. `process.stdout.columns` may not equal the effective display width that `notify` uses.

## Root cause — confirmed

`showStatus` creates `new Text(theme.fg("dim", message), 1, 0)` with `paddingX=1`.
`Text.render(chatWidth)` computes `contentWidth = chatWidth - 2` and calls
`wrapTextWithAnsi(text, contentWidth)`.

Pre-rendered lines are `renderWidth` chars wide (visible). With
`renderWidth = process.stdout.columns ≈ chatWidth`, each line is **2 chars wider
than `contentWidth`**. `wrapTextWithAnsi` wraps the 2-char overflow onto a new
line. That overflow line has background covering only 2 chars; Text pads the
remaining `chatWidth - 2` chars with plain spaces → the gray bar.

**Fix applied:** render two versions — TUI at `width`, notify at `width - 2`:

```typescript
render(width) {
  const tuiLines = renderRunsBoard(all, theme, width).render(width);
  const notifyWidth = Math.max(1, width - 2);
  const notifyLines = renderRunsBoard(all, theme, notifyWidth).render(notifyWidth);
  done(notifyLines.join("\n"));
  return tuiLines;
},
```

`width - 2` matches `contentWidth` exactly, so `wrapTextWithAnsi` never wraps.
The only remaining border is the 1-char left/right margin from `Text` itself, which
is terminal-default colored on both sides (narrow, acceptable).

## What to investigate next (historical)

### 1. What does `ctx.ui.notify` actually do?

Find its implementation in `node_modules/@earendil-works/pi-coding-agent`. Does it:
- Write the string directly to `process.stdout`?  → `process.stdout.columns` IS correct
- Display within a TUI panel at a fixed or dynamic width?  → width parameter from `ctx.ui.custom` IS correct
- Strip or rewrap ANSI codes?

```bash
grep -r "notify" node_modules/@earendil-works/pi-coding-agent/dist/ --include="*.js" -l
```

### 2. Log the widths at runtime

Add temporary logging to `jobs-command.ts`:

```typescript
render(width) {
  console.error(`[jobs-debug] panelWidth=${width} columns=${process.stdout.columns}`);
  // ...
}
```

Run `/jobs` and check stderr. If `process.stdout.columns` diverges from `width` by a large amount, that reveals the mismatch direction.

### 3. Compare with progress renderer

`DynamicSubagentProgressText.render(width)` receives `width` from the TUI loop directly. The jobs board receives it via `ctx.ui.custom`. Check whether both paths call into the same TUI layout engine, or whether `ctx.ui.custom` uses a different width source.

### 4. Check the return value of `ctx.ui.custom render()`

The render callback returns `lines` (at `renderWidth`), AND the TUI itself may display those returned lines in the panel at `width`. If `renderWidth ≠ width`, the TUI panel display could be broken (lines too wide → truncated or wrapped), even if notify is correct.

Consider keeping the TUI render separate from the notify render:

```typescript
render(width) {
  // render at panel width for the TUI display
  const tuiLines = renderRunsBoard(all, theme, width).render(width);
  // render at notify width for ctx.ui.notify
  const notifyWidth = process.stdout.columns ?? width;
  const notifyLines = renderRunsBoard(all, theme, notifyWidth).render(notifyWidth);
  done(notifyLines.join("\n"));
  return tuiLines;
},
```

### 5. Try rendering at a fixed large width

As a quick experiment, render at `200` and see if the gray bars shift or disappear. That would confirm or deny the width-mismatch theory.

## Key file locations

| File | Lines | Notes |
|------|-------|-------|
| `src/jobs-command.ts` | 28–35 | Width selection + render call — current fix applied here |
| `src/ui.ts` | 355–390 | `renderRunsBoard` — sections + job card layout |
| `src/ui.ts` | 270–290 | `renderStatusCard` — outer Box with bgFn |
| `src/ui.ts` | 292–310 | `makeStatusCardBody` — inner Box without bgFn |
| `src/progress.ts` | 107–121 | `renderProgressBox` — reference impl that works correctly |
| `node_modules/@earendil-works/pi-tui/dist/components/box.js` | 53–93 | Box.render — outer bgFn applied to all child lines |
| `node_modules/@earendil-works/pi-tui/dist/components/text.js` | 37–87 | Text.render — no bgFn = spaces only |
| `node_modules/@earendil-works/pi-tui/dist/utils.js` | ~758 | `applyBackgroundToLine` — pads to width, wraps in bgFn |

## Confirmed facts

- pi-tui `Box.applyBg` pads every line to full render width before calling bgFn → background covers entire line IF render width matches display width
- Outer Box's bgFn IS propagated to all child content including nested Boxes without bgFn (confirmed by `ui.test.ts` expectations)
- Adding bgFn to the inner body Box causes double-wrapping → wrong (tried and reverted)
- `renderProgressBox` (working) adds `Text` nodes directly to the outer Box; `renderStatusCard` (broken) adds a nested `Box` — structurally equivalent from the TUI's perspective, so the nested Box is NOT the cause
