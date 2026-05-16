# Fix Job Result Background

## Goal

- Use the current result card as the canonical visual pattern.
- Replace bespoke `/jobs` cards with abridged result cards.
- Preserve the themed approach with status colors and backgrounds.
- Avoid separate layout/styling rules that drift across result and jobs UI.

## Current Problem

- `/jobs` uses a custom `renderJobCard()` path.
- Result cards use a different structure and currently look better.
- Job cards show jagged or incomplete background coverage in screenshots.
- Padding changes improved structure but did not fully fix background continuity.
- The likely underlying issue comes from styled child strings and parent background composition interacting poorly.

## Direction

Use one shared themed card shell for result cards and job cards.

```ts
renderStatusCard({
  status,
  title,
  meta,
  body,
  footer,
  variant: "full" | "abridged",
});
```

The shared shell owns:

- status icon
- status color
- status background
- title formatting
- metadata formatting
- body indentation
- footer formatting
- padding
- width-safe rendering

## Result UI

Result UI should use `variant: "full"`.

It should keep:

- full output body
- result footer
- model/context/turn/duration/cost metadata
- current result card visual intent

The extraction should preserve the current result card look as much as possible.

## Jobs UI

`/jobs` should use `variant: "abridged"`.

Each job card should show:

- title
- status
- compact metadata
- one-line body preview

It should omit detailed footers by default.

## Jobs Sections

Group `/jobs` output in this order:

1. `ACTIVE`
2. `FAILED`
3. `CANCELLED`
4. `SUCCEEDED`

Rationale:

- Active work comes first.
- Failed jobs need urgent visibility.
- Cancelled jobs have distinct meaning from failed jobs.
- Successful jobs form completed history.

## Example Shape

```text
ACTIVE (1)
────────────────────────

● work apt-phoenix [running] · 2 tools · 4% ctx · 12.4s

  running tests
```

```text
FAILED (1)
────────────────────────

✗ test-runner smoke [error] · 3 tools · 18% ctx · 21.0s

  bun test failed with exit code 1
```

```text
SUCCEEDED (1)
────────────────────────

✓ work apt-phoenix [success] · 0 tools · 4% ctx · 5.3s

  wrote a short poem about claude
```

## Vibe Check

### Strengths

- Aligns `/jobs` with the existing result card style.
- Removes a fragile, separate `renderJobCard()` implementation.
- Makes `/jobs` feel like a compact history of result cards.
- Keeps cancelled jobs separate from failed jobs.
- Reduces visual drift between UI surfaces.

### Risks

- Shared shell may expose background-reset issues that the current result card only masks.
- Abridged cards may look taller than current job rows.
- Tests will need updates for section order, spacing, and card structure.

### Adjustments

- Scope the first implementation to result and jobs UI only.
- Extract the shell from the current result card, not from the broken job card.
- Keep abridged job cards compact:
  - one body line
  - no footer by default
  - result-card padding only when background continuity renders correctly
- Add regression coverage for background continuity.

## Implementation Plan

1. Extract a shared themed card shell from the current result card.
2. Port result UI onto the shared shell without intentional visual changes.
3. Replace `/jobs` cards with abridged shell cards.
4. Change `/jobs` section grouping to `ACTIVE`, `FAILED`, `CANCELLED`, `SUCCEEDED`.
5. Update tests for new grouping and abridged card rendering.
6. Verify with screenshots and targeted UI tests.

## Non-goals

- Do not overhaul progress UI in the first pass.
- Do not switch to Markdown-only presentation.
- Do not remove themed styling.
- Do not patch ANSI resets with brittle string rewriting unless shell extraction proves insufficient.
