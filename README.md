# Subagent Example

Delegate one task to one specialized subagent with an isolated context window.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Single-purpose delegation**: One tool call activates exactly one subagent
- **Streaming output**: See tool calls and progress as they happen
- **Markdown rendering**: Final output renders with proper formatting in expanded view
- **Usage tracking**: Shows turns, tokens, cost, and context usage
- **Abort support**: Ctrl+C kills the subagent process

## Structure

```text
subagent/
├── README.md            # This file
├── index.ts             # Extension entry point
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose agent
└── prompts/             # Single-agent prompt templates
    ├── scout.md         # Run scout once
    ├── plan.md          # Run planner once
    └── review.md        # Run reviewer once
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink prompt templates
mkdir -p ~/.pi/agent/prompts
for f in prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security model

This tool executes a separate `pi` subprocess with a delegated system prompt, inherited model, and optional tool/thinking configuration.

**Project-local agents** (`.pi/agents/*.md`) live in repositories and can instruct the model to read files, run bash commands, and use other tools.

**Default behavior:** The tool loads only user-level agents from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` or `agentScope: "project"`. Only do this for trusted repositories.

When running interactively, the tool asks before running project-local agents. Set `confirmProjectAgents: false` to disable the prompt.

## Usage

### Single agent

```text
Use scout to find all authentication code
```

Equivalent tool call:

```json
{
  "agent": "scout",
  "task": "Find all authentication code"
}
```

For multi-step work, let the main agent orchestrate multiple separate subagent calls. Each call should delegate one clear task to one subagent.

## Tool parameters

| Parameter | Description |
| --- | --- |
| `agent` | Agent name |
| `task` | Task to delegate |
| `cwd` | Optional working directory override |
| `agentScope` | `user`, `project`, or `both`; defaults to `user` |
| `confirmProjectAgents` | Ask before running project-local agents; defaults to `true` |

## Output display

**Collapsed view** shows:

- Status icon and agent name
- Recent tool calls and text output
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O) shows:

- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Usage stats

## Agent definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
skills: troubleshoot, coverage
thinking: high
---

System prompt for the agent goes here.
```

Subagents inherit the parent session model. Use optional `thinking` to override the parent thinking level for that agent.

Use optional `skills` to restrict skill invocation for an agent. When omitted, the subagent can invoke all skills discovered by Pi. When present, the subagent starts with skill discovery disabled and only receives the listed skills. An empty `skills` field disables every skill for that agent.

**Locations:**

- `~/.pi/agent/agents/*.md` - User-level agents
- `.pi/agents/*.md` - Project-level agents, only loaded with `agentScope: "project"` or `"both"`

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample agents

| Agent | Purpose | Thinking | Tools |
| --- | --- | --- | --- |
| `scout` | Fast codebase recon | low | read, grep, find, ls, bash |
| `planner` | Implementation plans | high | read, grep, find, ls |
| `reviewer` | Code review | medium | read, grep, find, ls, bash |
| `worker` | General-purpose work | medium | default tools |

## Error handling

- Non-zero exit code returns an error with stderr/output
- `stopReason: "error"` propagates the model error
- `stopReason: "aborted"` reports user abort
- Ctrl+C kills the subprocess
