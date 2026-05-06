# Fix Outcome Semantics Plan

## Goal

Preserve `Outcome:` semantics consistently across feedback summary extraction and result rendering.

## Plan

1. Add focused tests for outcome precedence and rendering.
   - Assert `summarizeFeedbackUiFinalOutput` prefers a later `Outcome:` value over earlier `Summary:` or `Status:` labels.
   - Assert outcome-only output renders the outcome text instead of `(no output)`.
   - Assert mixed output still strips the `Outcome:` line when other non-empty body lines remain.
2. Update `src/summary.ts` summary candidate handling.
   - Track the matched label name for each candidate, not only a `labeled` boolean.
   - Prefer valid `outcome` candidates first.
   - Fall back to other valid labeled candidates.
   - Fall back to valid unlabeled candidates.
   - Keep existing normalization, generic-value filtering, and truncation behavior.
3. Update `src/ui.ts` outcome stripping.
   - Strip `Outcome:` lines only when the stripped result still contains non-empty body content.
   - Return the original output when `Outcome:` provides the sole content.
4. Verify the change.
   - Run targeted tests for summary and UI behavior.
   - Run `bun verify`.

## Vibe Check Notes

- The plan directly addresses the reported summary precedence and rendering issues.
- The implementation should stay narrow: no broad refactor, only label metadata plus conditional stripping.
- Tests should lock both preservation and stripping behavior.
