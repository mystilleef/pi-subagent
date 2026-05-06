# Clean Subagent Feedback UI Plan

## Scope

Change only the terminal/final output shown in the collapsed subagent feedback/progress UI preview.

Do not change:

- Running feedback/tool preview lines.
- Subagent result UI cards.
- Parent-facing subagent tool text.
- `details.results[0].finalOutput`.
- Debug output or child messages.

## Goal

The final feedback preview should render as one very short semantic sentence:

- `SUCCESS: <summary>` for successful operations.
- `FAILURE: <summary>` for failed operations.
- `<summary>` with no prefix when classification lacks enough signal.

Examples:

- `SUCCESS: Committed code review changes`
- `FAILURE: Couldn't fetch deps due to network error`
- `Handing off code review summary`

## Implementation Plan

1. Update `src/progress.ts` only.
2. Add a compact terminal preview helper for feedback UI state.
3. For `finalizeProgressState()`:
   - Derive a short semantic sentence from the final output.
   - Prefer an `Outcome:` line when present.
   - Otherwise use the first useful filtered output line.
   - Normalize whitespace and strip simple labels/markdown wrappers.
   - Cap the sentence to a compact length.
   - Prefix with `SUCCESS:` only when the result clearly succeeded and the sentence has content.
4. For `failProgressState()`:
   - Derive a short semantic sentence from the error text.
   - Prefix with `FAILURE:` for failed terminal feedback.
5. Keep cancelled or ambiguous/unclassified terminal feedback unprefixed unless later requirements say otherwise.
6. Keep expanded feedback behavior minimal and avoid exposing full raw output changes unless the existing progress renderer already does so.

## Tests

Update `test/progress.test.ts` only:

- Collapsed terminal success feedback renders a single compact `SUCCESS:` sentence.
- Collapsed terminal failure feedback renders a single compact `FAILURE:` sentence.
- Ambiguous/unclassified terminal feedback renders a compact sentence without a prefix.
- Terminal progress still omits running tool previews.
- No tests for `renderSubagentResult()` should change.

## Verification

Run:

```sh
bun test test/progress.test.ts
bun verify
```
