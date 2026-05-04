# Agent

A specialized extension for `pi` (the coding agent) that enables
subagent orchestration. It allows delegating tasks to isolated subagent
processes with their own context windows, supporting both user-global
and project-local agent definitions.

## Project overview

- **Purpose:** Provide a `subagent` tool and a `/run` command for `pi`
  to delegate tasks to specialized agents.
- **Main Technologies:**
  - **Runtime:** Node.js / Bun
  - **Language:** TypeScript
  - **Frameworks:** `@mariozechner/pi-agent-core`,
    `@mariozechner/pi-ai`, `@mariozechner/pi-tui` (for CLI UI)
  - **Tooling:** Biome (linting/formatting), `Vitest` (testing via
    `bun test`)
- **Architecture:**
  - `src/index.ts`: Main entry point, registers the `subagent` tool and
    UI components.
  - `src/agents.ts`: Logic for discovering and parsing agent definitions
    from markdown files with `frontmatter`.
  - `prompts/run.md`: A prompt template for the `/run` command.

## Building and running

- **Verify:** `bun verify`
- **Coverage:** `bun coverage`
- **Update Dependencies:** `bun update`
- **Install Dependencies:** `bun install`

## Development conventions

- **Agent Definitions:** Users define agents as Markdown files with YAML
  `frontmatter`.
  - **Location:** `~/.pi/agents/` (user-global) or `.pi/agents/`
    (project-local).
  - **Frontmatter Fields:** `name`, `description`, `tools`
    (comma-separated), `skills` (comma-separated), `thinking` (`off`,
    `minimal`, `low`, `medium`, `high`, `xhigh`).
  - **Body:** The system prompt for the agent.
- **Subagent Tool:**
  - Spawns a new `pi` process in JSON mode.
  - Captures and streams output back to the parent UI.
  - Truncates returned output to `PI_SUBAGENT_MAX_OUTPUT_BYTES` (default
    `30000`) and `PI_SUBAGENT_MAX_OUTPUT_LINES` (default `300`).
  - Supports `agentScope` (`user`, `project`, or `both`).
- **Code Style:** Enforced by Biome. Use `bun run check` to fix issues
  automatically.
- **Testing:** Find comprehensive integration tests in
  `test/index.test.ts`.

## Rules

- Remove all empty lines inside functions.
