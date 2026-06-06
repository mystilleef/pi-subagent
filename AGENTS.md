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

## Gotchas

- Avoid empty lines inside functions.
- Maintain exactly one empty line before and after functions and
  classes.
- Never commit or track the proposals folder or files.
