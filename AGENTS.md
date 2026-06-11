# Agent

## Commands

- **Check:** `bun check`
- **Test** `bun verify`

## Workflow

- **CI:** Pull requests trigger:
  - `bun verify`
  - `bun pack:smoke`

## Rules

- Never make autonomous commits
- Write asynchronous, non-blocking code.
- Write code that never blocks the `TUI`/`GUI`.
- Write testable code.
- After edits:
  - Run `bun check` for type checking and to fix trivial lint issues.
  - Run `bun verify` for full suite comprehensive testing.

### Testing rules

- Before writing tests, read relevant `bun` testing guides, on demand,
  in `./docs/bun/testing`. The agent file in that folder indexes what
  each guide documents.

## Gotchas

- Avoid empty lines inside functions.
- Maintain exactly one empty line before and after functions and
  classes.
- Never commit or track the proposals folder or files.
