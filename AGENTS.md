# Agent

`pi-subagent` extends `pi` with subagent orchestration: the `subagent`
tool and `/run` command delegate work to isolated child `pi` processes
with separate context windows.

## Project overview

- **Purpose:** Delegate tasks to specialized agents from user-global and
  project-local Markdown definitions.
- **Runtime:** Bun on Node-compatible TypeScript.
- **Language:** TypeScript, ES modules.
- **Pi integration:** `package.json` registers `./src/index.ts` through
  `pi.extensions`.
- **Core dependencies:** `@mariozechner/pi-agent-core`,
  `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-tui`, and `typebox`.
- **Tooling:** Biome, TypeScript, and Bun test runner.

## Architecture

- `src/index.ts`: Registers the tool, `/run`, autocomplete, UI,
  cancellation, project-agent confirmation, result cleanup, and progress
  patching.
- `src/agents.ts`: Discovers user and project agents, parses
  `frontmatter`, resolves scope, and formats agent lists.
- `src/process.ts`: Launches child `pi --json` processes, resolves
  prompts, streams updates, tracks usage, captures messages, and reports
  failures.
- `src/progress.ts`: Tracks running, successful, failed, and cancelled
  tool calls.
- `src/summary.ts`: Normalizes child output and filters transcript
  noise.
- `src/ui.ts`: Formats tool calls, result cards, usage details, and
  progress views.
- `src/utils.ts`: Handles `pi` invocation, output truncation, temporary
  prompt files, skill arguments, depth tracking, and message-error
  detection.
- `src/types.ts`: Defines shared result, usage, details, and update
  callback types.

## Commands

- Install dependencies: `bun install`
- Update dependencies: `bun update`
- Verify checks and tests: `bun verify` or `make verify`
- Check coverage: `bun coverage` or `make coverage`
- Run Biome migration: `bun run migrate` or `make migrate`

## Agent definitions

- Define agents as Markdown files with YAML `frontmatter`.
- Store user-global agents in `~/.pi/agents/*.md`.
- Store project-local agents in the nearest `.pi/agents/*.md`.
- Include required `name` and `description` fields.
- Optionally include `tools`, `skills`, and `thinking` fields.
- Use comma-separated values for `tools` and `skills`.
- Set `thinking` to `off`, `minimal`, `low`, `medium`, `high`, or
  `xhigh`.
- Use the Markdown body as the appended system prompt.

## Subagent behavior

- The `subagent` tool accepts `agent`, `task`, optional `agentScope`,
  and optional `debug`.
- `agentScope` accepts `user`, `project`, or `both`; default `both`.
- `/run <agent> [task]` delegates through `subagent`, summarizes the
  result, then stops.
- `/run` autocomplete suggests discovered agent names.
- Child processes run through `pi --json` with a generated prompt file.
- Updates stream back to the parent UI during execution.
- Returned details omit full child messages unless `debug` has a true
  value.

## Safeguards and limits

- Project-local agents require UI confirmation when UI context exists.
- Nested subagent calls use `PI_SUBAGENT_DEPTH`; execution stops at
  depth `1`.
- Output truncation uses `PI_SUBAGENT_MAX_OUTPUT_BYTES` with default
  `50000` and `PI_SUBAGENT_MAX_OUTPUT_LINES` with default `500`.
- Failures propagate through structured details and filtered parent
  summaries.

## Testing

- Tests live under `test/` and cover discovery, process execution,
  `/run`, tool contract, progress state, summaries, UI rendering,
  utilities, safeguards, truncation, and error handling.
- Test support files: `test/helpers.ts` and `test/preload.ts`.

## Rules

- Remove all empty lines inside TypeScript and JavaScript functions.
- Don't add empty lines inside TypeScript and JavaScript functions.
