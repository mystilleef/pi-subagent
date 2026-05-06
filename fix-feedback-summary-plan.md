# Fix feedback summary output

## Goal

Make the subagent feedback UI final output a single compact semantic sentence. The header already communicates success or failure, so the body must not include `SUCCESS`, `FAILURE`, or equivalent status prefixes.

## Problem

Current parent-side post-processing can produce noisy output such as:

- `SUCCESS: SUCCESS`
- `SUCCESS: done`
- `FAILURE: FAILURE: child failed`

This duplicates the feedback UI header and fails to provide semantic meaning.

## Plan

1. Update `src/progress.ts`.
   - Remove `SUCCESS:` and `FAILURE:` prefix injection.
   - Strip incoming status prefixes from child output.
   - Keep compact sentence normalization and truncation.

2. Improve semantic extraction.
   - Prefer explicit `Outcome:` lines.
   - Otherwise use the first meaningful content line.
   - Strip labels such as `Status:`, `Summary:`, `Result:`, `Output:`, `Message:`, `Error:`, and `Check:`.
   - Treat bare status-only values as non-semantic:
     - `SUCCESS`
     - `DONE`
     - `FAILURE`
     - `FAILED`
     - `ERROR`

3. Handle non-semantic fallback.
   - For success with only status output, use a compact fallback such as `completed task`.
   - For failure with only status output, prefer extracted error details.
   - If no meaningful failure detail exists, use a compact fallback such as `task failed`.

4. Update tests.
   - Replace prefixed expectations with semantic-only expectations.
   - Add regression coverage for:
     - `SUCCESS: SUCCESS`
     - `SUCCESS`
     - `DONE`
     - `FAILURE: FAILURE`
     - long output truncation without status prefix

5. Verify.
   - Run focused progress tests.
   - Run full verification after focused tests pass.

## Design rule

Header owns status. Body owns meaning.
