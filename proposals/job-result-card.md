# Proposal: `/jobs` Result Card

## Root cause

`jobs-command.ts` constructs `makePlainTheme()`, which stubs every `fg`/`bg`/`bold`
call to an identity function. `renderRunsBoard` is fully theme-wired but renders
colorless because the wrong theme reaches it. The board also has no visual structure —
flat list, 80-char body cap, no grouping, no card separation.

---

## Change 1 — `src/jobs-command.ts`: use the live theme singleton

`pi-coding-agent` exports `theme`: a global Proxy singleton initialized by pi at
startup, before any command handler can run. Its `Theme` class has
`.fg(ThemeColor, text)`, `.bg(ThemeBg, text)`, `.bold(text)`, and `.italic(text)` —
structurally identical to `SubagentTheme`. No chalk, no new dependencies, no hardcoded
colors. User theme changes are honored automatically.

Remove `makePlainTheme`, the now-unused `ThemeColor` import, and the `ThemeBg` import.
Add:

```ts
import { theme } from "@earendil-works/pi-coding-agent";
```

Replace the board construction:

```ts
// before
const board = renderRunsBoard(all, makePlainTheme());
const width = process.stdout.columns ?? 80;
const output = board.render(width).join("\n");
ctx.ui.notify(output);

// after
const width = process.stdout.columns ?? 80;
const board = renderRunsBoard(all, theme, width);
ctx.ui.notify(board.render(width).join("\n"));
```

If TypeScript rejects `theme` where `SubagentTheme` is expected (possible if nominal
types diverge slightly), the fix is `theme as unknown as SubagentTheme` — no
behavioral change.

---

## Change 2 — `src/ui.ts`: redesign `renderRunsBoard`

**Import addition:** add `STATUS_BG` to the existing `progress-state.js` import
(already exported, just missing here).

**Signature:** add `width = 80` — needed for the section ruler and already required by
`board.render(width)` at the call site.

```ts
export function renderRunsBoard(
  states: SubagentProgressState[],
  theme: SubagentTheme,
  width = 80,
): Component
```

### Visual structure

80-col terminal, 1 active + 2 completed:

```
  ACTIVE (1)
  ──────────────────────────────────────────────────────────────────────

  ● researcher  analyze-auth-logs     [running]  12 tools · 45% ctx · 2m34s
    Examining authentication patterns in the logs and correlating them with…

  COMPLETED (2)
  ──────────────────────────────────────────────────────────────────────

  ✓ writer  draft-release-notes       [success]  23 tools · 78% ctx · 8m01s
    Added 12 new tests across 4 files. Coverage increased from 67% to 84%…

  ⊘ reviewer  check-pr-42            [cancelled]  4 tools · 22% ctx · 1m20s
    (cancelled)
```

### Component tree

```
outer Box(0, 1)
  ├─ [if active non-empty]
  │   ├─ Text "  ACTIVE (n)"            fg("dim", ...)
  │   ├─ Text "  ──────..."             fg("dim", ...) — "─".repeat(width - 4)
  │   └─ per active state:
  │       ├─ Box(1, 1, line => theme.bg(STATUS_BG[status], line))
  │       │     ├─ Text: header line
  │       │     └─ Text: body (indented 2, fg("toolOutput", ...))
  │       └─ Text ""   (spacer; omit after last entry in section)
  │
  └─ [if completed non-empty]
      ├─ Text "  COMPLETED (n)"         fg("dim", ...)
      ├─ Text "  ──────..."             fg("dim", ...)
      └─ per completed state:
          ├─ Box(1, 1, line => theme.bg(STATUS_BG[status], line))
          │     ├─ Text: header line
          │     └─ Text: body (indented 2, fg("toolOutput", ...))
          └─ Text ""   (spacer; omit after last entry)
```

Section headers only render for non-empty groups — no `ACTIVE (0)` appears when no
jobs are running.

### Header line

Same fields as today, now colored:

```
icon  title  [status]  N tools · ctx% ctx · elapsed
```

### Body preview

- Source priority: `finalOutput` → `errorText` → `taskPreview`
- Truncation: 120 chars with ellipsis (up from 80)
- Indented 2 spaces, rendered with `fg("toolOutput", ...)`
- All sources empty: `fg("muted", "(no output)")`

---

## What does not change

- Sort order: active-first, both groups newest-first.
- `formatSubagentTitle`, `formatElapsed`, `formatContextPercent` — untouched.
- `STATUS_COLOR`, `STATUS_ICON` — untouched.
- `renderSubagentResult`, `renderSubagentCall` — untouched.
- Empty-state fallback (`"No /run jobs in this session."`) — untouched.

## Test impact

`test/ui.test.ts` calls `renderRunsBoard` with a plain stub theme — the new
`width = 80` default requires no signature changes. The `STATUS_BG` import is
additive. `jobs-command.ts` is not exercised by existing tests, so the singleton
swap has zero test impact.
