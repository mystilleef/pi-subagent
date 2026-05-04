---
description: Execute a subagent with optimized instructions
argument-hint: "<agent> [task]"
---

Delegate task to agent.

- **Agent:** `$1`
- **Task:** `${@:2}`

## Instructions

1. Use the `subagent` tool to delegate the task to the agent.
2. Return a summary of the agent's result.
3. Stop. Perform no further operations.

## Rules

- Invoke the agent immediately.
- Don't perform any operations before invocation.
- If a task exists, refine, `consolidate`, and optimize the task text
  for agent, token, context efficiency.
- Optimize agent summary for token and context efficiency using elegant,
  idiomatic markdown.
