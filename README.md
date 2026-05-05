# Pi subagent

Delegate Pi work to isolated child Pi processes. This extension adds the
`subagent` tool and `/run` command so a parent Pi session can hand work
to a named agent with its own context window, prompt, tools, skills,
thinking level, and result stream.

## Setup

- Runtime: Bun, Node-compatible TypeScript, ES modules.
- Install dependencies: `bun install`.
- Pi discovers the extension from `package.json` `pi.extensions` at
  `./src/index.ts`.

## Commands

- Verify checks and tests: `bun verify` or `make verify`.
- Run checks, tests, and coverage: `bun coverage` or `make coverage`.
- Apply Biome fixes and type-check: `bun run check` or `make check`.
- Run Biome migrations: `bun run migrate` or `make migrate`.

## Usage

### `/run <agent> [task]`

Delegates through the `subagent` execution path, renders live progress,
emits a final result card, then stops. Autocomplete suggests known user
and project agents after `/run `.

Use `/run --debug <agent> [task]` to include child messages in display
details.

## Agent definitions

Pi subagent loads Markdown agent files from:

- user agents: `~/.pi/agents/*.md`
- nearest project agents directory: `.pi/agents/*.md`, found by walking
  up from the current working directory

`Frontmatter` fields:

- required: `name`, `description`
- optional: `tools`, `skills`, `thinking`

`tools` and `skills` use comma-separated values. `thinking` accepts
`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. The Markdown body
supplies the appended system prompt.

Project agents override user agents with the same name when `agentScope`
includes both sources.

## Runtime behavior

- Child processes run in the parent working directory through the
  current Pi invocation when possible, or the `pi` binary fallback.
- Agent system prompts use temporary `0600` files passed through
  `--append-system-prompt`; cleanup runs after completion.
- Agent `tools` map to `--tools`.
- Agent `skills` resolve through Pi's resource loader and map to
  `--skill` paths.
- Child output receives result-format instructions for concise Markdown
  summaries optimized for the parent agent.
- Usage details track turns, tokens, cache use, context tokens, cost,
  model, duration, `stderr`, and stop reason.

## UI and summaries

- Tool calls render the selected agent, scope, and semantic task target.
- `/run` progress tracks status, elapsed time, tool count, last tool
  preview, usage stats, final output, and semantic errors.
- Final result cards render Markdown output and compact usage
  statistics.
- Parent summaries filter transcript noise and failure diagnostics
  before display.
- Returned details omit full child messages unless `debug` requests them
  or live progress needs a short recent-message snapshot.

## Architecture

- `src/index.ts`: registers the `subagent` tool, `/run` command,
  autocomplete, UI confirmation, progress updates, result cleanup, and
  `renderers`.
- `src/agents.ts`: discovers user and project agent files, parses
  `frontmatter`, resolves scope, and formats agent lists.
- `src/process.ts`: launches child Pi processes; resolves prompts,
  tools, skills, model, thinking, depth, updates, usage, failures, and
  cleanup.
- `src/progress.ts`: tracks running, successful, failed, and cancelled
  `/run` progress and renders dynamic progress cards.
- `src/summary.ts`: normalizes child output, extracts semantic tool
  targets, and filters transcript noise.
- `src/ui.ts`: formats tool calls, result cards, Markdown output, usage
  details, and final assistant output extraction.
- `src/utils.ts`: handles Pi invocation, output truncation, temporary
  prompt files, skill arguments, depth environment values, and
  message-error detection.
- `src/types.ts`: defines shared result, usage, details, and update
  callback types.

## Safeguards and limits

- Project-local agents require UI confirmation before execution when UI
  support exists.
- Nested subagent calls use `PI_SUBAGENT_DEPTH`; execution stops at
  depth `3`.
- Output truncation uses `PI_SUBAGENT_MAX_OUTPUT_BYTES` with default
  `50000` and `PI_SUBAGENT_MAX_OUTPUT_LINES` with default `500`.
- `Stderr` capture stops after `10000` bytes.
- Failed child tool results, error stop reasons, aborts, and non-zero
  exits propagate as parent errors.

## Testing

Tests live under `test/` and cover discovery, tool execution, `/run`,
progress state, summaries, UI rendering, utilities, safeguards,
truncation, and error handling.
