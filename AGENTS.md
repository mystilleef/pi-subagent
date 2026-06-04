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
- **Core dependencies:** `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, and `typebox`.
- **Tooling:** Biome, TypeScript, and Bun test runner.

## Architecture

- **Entry point:** `src/index.ts` registers the extension, renderers,
  commands, and autocomplete.
- **Agent discovery** (`src/agent/`): `agents.ts` and `agent-cache.ts`
  find, parse, and cache user and project agent definitions.
- **Orchestration** (`src/orchestration/`): `subagent-orchestrator.ts`,
  `run.ts`, `run-command.ts`, `run-registry.ts`, `cancel-command.ts`,
  and `jobs-command.ts` handle tool dispatch, `/run`, job tracking, and
  cancellation.
- **Child process** (`src/child/`): `process.ts`, `child-events.ts`,
  `termination.ts`, and `prompt-contract.ts` launch and manage child
  `pi --json` processes.
- **Progress** (`src/progress/`): `progress.ts`, `progress-state.ts`,
  and `result-details.ts` track and render tool call state.
- **Output** (`src/output/`): `summary.ts`, `ui.ts`, and `normalize.ts`
  normalize, filter, and format child output.
- **Shared** (`src/shared/`): `utils.ts`, `types.ts`, and
  `instance-name.ts` provide invocation helpers, truncation, depth
  tracking, and shared types.

## Commands

- Full verification: `bun verify`
- Fix formatting: `bun fix`
- Lint checks: `bun check`
- Test coverage: `bun coverage`
- Biome migration: `bun migrate`
- Install dependencies: `bun install`
- Update dependencies: `bun update`

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
  depth `3`.
- Output truncation uses `PI_SUBAGENT_MAX_OUTPUT_BYTES` with default
  `50000` and `PI_SUBAGENT_MAX_OUTPUT_LINES` with default `500`.
- Failures propagate through structured details and filtered parent
  summaries.

## Testing

- Tests live under `test/`: `child-events.test.ts`,
  `coverage-gaps.test.ts`, `process.test.ts`, `progress.test.ts`,
  `run-command.test.ts`, `subagent-tool.test.ts`, `summary.test.ts`,
  `termination.test.ts`, `ui.test.ts`, and `utils.test.ts`.
- Test support files: `test/helpers.ts` and `test/preload.ts`.

## Rules

- Remove all empty lines inside TypeScript and JavaScript functions.
- Don't add empty lines inside TypeScript and JavaScript functions.
- Leave an empty line before and after functions and classes.
- **NEVER** track or commit the proposals folder.
