# Subagent

`pi-subagent` adds isolated subagent orchestration to
[Pi](https://github.com/earendil-works/pi). It provides a `subagent`
tool and `/run` command for delegating work to specialized agents in
separate child Pi processes. Designed especially for the `SPAE`
framework, but doesn't require it.

## Action

Agents in
[action](https://raw.githubusercontent.com/mystilleef/pi-subagent/main/assets/parallel-agents-demo.mp4).

## Installation

**Install from `npm`:**

```sh
pi install npm:@mystilleef/pi-subagent
```

**Try temporarily without installing:**

```sh
pi -e npm:@mystilleef/pi-subagent
```

## Features

- **Asynchronous:** Agents run in the background.
- **Parallel:** Run many agents simultaneously.
- **Isolated:** Each delegated task receives a separate context window.
- **Simple:** No complex orchestration workflow required.
- **Bloat-free:** No bundled agents.

## Usage

**Run an agent with an optional task:**

```text
/run agent [optional task]
```

**Examples:**

```text
/run spec implement google login screen
/run plan
/run inspect
/run build
/run verify
```

**Use natural language to launch agents in parallel:**

```text
use the work agent to write a poem about linux; use the commit agent to make
commits; use the query agent to summarize the project.
```

**Show active and completed jobs:**

```text
/jobs
```

**Cancel running `subagents`:**

```text
/cancel-subagent
```

## _SPAE_ Workflow

`pi-subagent` supports the
[`SPAE` Framework](https://github.com/mystilleef/spae-framework), but
doesn't require it. `SPAE` provides pre-built agents and skills for a
structured workflow.

| Phase | Agent                     | Purpose                                       |
| ----- | ------------------------- | --------------------------------------------- |
| 1     | `/run spec <requirement>` | Distill requirements into `SPEC.md`           |
| 2     | `/run plan`               | Decompose `SPEC.md` into an atomic task graph |
| 3     | `/run inspect`            | Perform gap analysis and optimize `PLAN.md`   |
| 4     | `/run build`              | Carry out tasks from `PLAN.md`                |
| 5     | `/run verify`             | Verify implementation against `SPEC.md`       |

## Agent definitions

This package ships no agents. Define agents as Markdown files with YAML
`frontmatter` and a Markdown system prompt body.

**Discovery locations:**

- User-global agents: `~/.pi/agents/*.md`
- Project-local agents: nearest `.pi/agents/*.md`

**Required `frontmatter`:**

```yaml
name: review
description: Review code for correctness and maintainability.
```

**Optional `frontmatter`:**

```yaml
tools: read, bash, edit
skills: code-review
thinking: medium
```

**Accepted `thinking` values:**

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

## Tool

The extension also registers a `subagent` tool for model-driven
delegation.

**Inputs:**

- `agent`: agent name.
- `task`: task prompt for the child agent.
- `agentScope`: optional lookup scope, one of `user`, `project`, or
  `both`.
- `debug`: optional flag that includes full child messages in result
  details.

## Security

`Subagents` launch child `pi --json` processes. Agents, tools, and
extensions run with user permissions, so treat agent definitions like
executable automation.

**Trust guidance:**

- Review project-local agents before running them.
- Avoid delegating secrets unless the agent and tools need them.
- Prefer trusted repositories for shared agent definitions.
- Remember that child agents can call their configured tools.

## Configuration and limits

**Environment variables:**

- `PI_SUBAGENT_DEPTH`: nested subagent depth guard. Nested calls stop at
  depth `3`.
- `PI_SUBAGENT_MAX_OUTPUT_BYTES`: max returned output bytes. Default:
  `50000`.
- `PI_SUBAGENT_MAX_OUTPUT_LINES`: max returned output lines. Default:
  `500`.

## Troubleshooting

**Missing agent:**

- Confirm the file lives under `~/.pi/agents/` or the nearest
  `.pi/agents/`.
- Confirm `frontmatter` includes `name` and `description`.
- Confirm `/run` uses the `name` value, not the filename.

**Project-local agent prompt:**

- Pi may request confirmation before loading project-local agents when
  UI context exists.

**Nested subagent blocked:**

- Nested delegation hits the `PI_SUBAGENT_DEPTH` safety limit.
- Run the child task directly from the parent session instead.

**Truncated output:**

- Raise `PI_SUBAGENT_MAX_OUTPUT_BYTES` or
  `PI_SUBAGENT_MAX_OUTPUT_LINES`.
- Ask the child agent for a shorter summary.

## Development

**Install dependencies:**

```sh
bun install
```

**Run full verification:**

```sh
bun verify
```

**Check npm package contents:**

```sh
bun pack:smoke
```
