# Agent

## Commands

- **Check:** `bun check`
- **Test:** `bun coverage`
- **Verify** `bun verify`

## Workflow

- **CI:** Pull requests trigger:
  - `bun check`
  - `bun coverage`
  - `bun pack:smoke`

## Rules

- Write asynchronous, non-blocking code.
- Write code that never blocks the `TUI`/`GUI`.
- Write testable code.
- After edits:
  - Run `bun check` to address lint issues
  - Run `bun coverage` to address test failures
  - Run `bun verify` at your discretion for comprehensive verification.

### Testing rules

- Before writing tests, read relevant `bun` testing guides, on demand,
  in `./docs/bun/testing`. The agent file in that folder indexes what
  each guide documents.

## Gotchas

- Avoid empty lines inside functions.
- Maintain exactly one empty line before and after functions and
  classes.
- Never commit or track the proposals folder or files.
