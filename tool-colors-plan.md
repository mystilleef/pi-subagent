# Tool Preview Color Plan

## Goal

Improve subagent feedback UI readability by styling tool preview parts independently:

- Arrow `→`: `muted`
- Tool name: `accent`
- Target/details: `dim`

## Scope

Touch only progress rendering and focused tests.

## Plan

1. Leave preview generation unchanged.
   - Keep `makeToolPreview()` behavior intact.
   - Preserve semantic targets and truncation.

2. Add render-time formatting in `src/progress.ts`.
   - Introduce a small helper that accepts `lastToolPreview` and `theme`.
   - Split on the first `:`.
   - Render the arrow with `theme.fg("muted", "→")`.
   - Render the tool name with `theme.fg("accent", toolName)`.
   - Render the separator and target with `theme.fg("dim", rest)`.

3. Handle both preview forms.
   - `bash: ls -la` renders as arrow + accented `bash` + dim `: ls -la`.
   - `bash` renders as arrow + accented `bash`.

4. Update running progress rendering.
   - Replace the current single dim wrapper around `→ ${state.lastToolPreview}`.
   - Keep collapsed and expanded layout unchanged.

5. Add focused tests in `test/progress.test.ts`.
   - Use a marker theme that exposes color names.
   - Assert arrow uses `muted`.
   - Assert tool name uses `accent`.
   - Assert target uses `dim`.
   - Cover previews with and without `:`.

6. Verify.
   - Run targeted progress tests.
   - Run full project verification if targeted tests pass.
