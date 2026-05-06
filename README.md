# Project summary

`pi-subagent` extends `pi` with subagent orchestration. It adds a `subagent` tool and `/run` command that delegate tasks to isolated child `pi --json` processes with separate context windows.

## Core flow

- Discovers user agents in `~/.pi/agents/*.md` and project agents in nearest `.pi/agents/*.md`.
- Parses Markdown frontmatter: `name`, `description`, optional `tools`, `skills`, `thinking`.
- Launches child Pi with generated prompt files, scoped tools/skills, depth tracking, streaming updates, usage capture, and structured failure handling.
- Returns concise parent-facing output while preserving detailed metadata when `debug: true`.

## Main modules

- `src/index.ts`: extension registration, `subagent` tool, `/run`, autocomplete, UI confirmation, progress patching, result cleanup.
- `src/agents.ts`: agent discovery, frontmatter parsing, scope resolution, list formatting.
- `src/process.ts`: child process launch, prompt resolution, streaming JSON handling, usage/error propagation.
- `src/progress.ts`: running/success/failure/cancelled progress state and rendering.
- `src/summary.ts`: child output normalization and transcript-noise filtering.
- `src/ui.ts`: tool/result cards, Markdown output, usage details.
- `src/utils.ts`: Pi invocation, output truncation, temp prompt files, skill args, depth env.
- `src/types.ts`: shared result/update/usage/detail types.

## Safeguards

- Project-local agents require UI confirmation when UI context exists.
- Nested subagent calls stop at depth `1` via `PI_SUBAGENT_DEPTH`.
- Output truncation defaults: `50000` bytes and `500` lines.
- Stderr capture stops after `10000` bytes.
- Child tool failures, aborts, error stop reasons, and non-zero exits propagate to parent errors.

## Tooling

- Runtime: Bun with TypeScript ES modules.
- Extension entry: `package.json` → `pi.extensions: ["./src/index.ts"]`.
- Commands:
  - `bun verify`: type/check plus tests.
  - `bun coverage`: coverage run.
  - `bun check`: Biome fix plus `tsc --noEmit`.

## Tests

Tests cover discovery, tool contract, `/run`, child process behavior, progress rendering, summaries, UI, utilities, safeguards, truncation, aborts, debug hygiene, and error handling.
