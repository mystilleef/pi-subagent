# Pi subagent

Delegate Pi work to isolated agent processes. This extension registers
the `subagent` tool and `/run` prompt so a parent Pi session can hand a
task to a named agent with its own context window.

## Setup

- Use Bun with the Node-compatible TypeScript sources in this
  repository.
- Install dependencies: `bun install`.
- Pi discovers:
  - the extension through `package.json` `pi.extensions`
    (`./src/index.ts`)
  - prompt templates through `package.json` `pi.prompts` (`./prompts`)

## Commands

- Verify checks and tests: `bun verify` or `make verify`.
- Run checks, tests, and coverage: `bun coverage` or `make coverage`.
- Apply Biome fixes and type-check: `bun run check` or `make check`.
- Run Biome migrations: `bun run migrate` or `make migrate`.

## Usage

### Subagent parameters

Parameters:

- `agent`: agent name to invoke.
- `task`: task text to delegate.
- `agentScope` (optional): `user`, `project`, or `both`; defaults to
  `both`.
- `debug` (optional): include full child messages in result details.

The tool discovers matching agent definitions, starts Pi in JSON mode
with an appended system prompt when configured, streams updates, and
returns final assistant output from the subagent.

### `/run <agent> [task]`

Delegates immediately through the `subagent` tool, summarizes the
result, then stops. Autocomplete suggests agent names after `/run ` from
user and project scopes.

## Agent definitions

Pi-subagent loads Markdown agent files from:

- user agents: `~/.pi/agents/*.md`
- nearest project agents directory: `.pi/agents/*.md`, found by walking
  up from the current working directory

`frontmatter`:

- required: `name`, `description`
- optional: `tools`, `skills`, `thinking`

`tools` and `skills` use comma-separated values. `thinking` accepts
`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. The Markdown body
supplies the appended system prompt for that agent.

## Architecture

- `src/index.ts`: registers the `subagent` tool, `/run` autocomplete, UI
  confirmation for project-local agents, and result rendering hooks.
- `src/agents.ts`: discovers user and project agent files, parses
  `frontmatter`, and builds agent configurations.
- `src/process.ts`: launches child Pi processes, applies model,
  thinking, tool, and skill settings, tracks usage, and enforces nesting
  depth.
- `src/ui.ts`: formats tool calls, result previews, usage summaries, and
  final output extraction.
- `src/utils.ts`: handles Pi invocation, output truncation, temporary
  prompts, skill resolution, depth environment values, and error
  detection.
- `src/types.ts`: defines result, usage, details, and update callback
  types.
- `prompts/run.md`: implements `/run <agent> [task]` delegation
  instructions.
- `test/index.test.ts`: covers process execution, discovery, truncation,
  rendering, prompts, safeguards, and error handling.

## Safeguards and limits

- Project-local agents require UI confirmation before execution when UI
  support exists.
- Nested `subagents` use `PI_SUBAGENT_DEPTH`; execution stops at depth
  `3`.
- Output truncation uses `PI_SUBAGENT_MAX_OUTPUT_BYTES` (default
  `50000`) and `PI_SUBAGENT_MAX_OUTPUT_LINES` (default `500`).
