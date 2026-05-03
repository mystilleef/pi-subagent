---
description: Execute a subagent with optimized instructions
argument-hint: "<agent> [task]"
---

Delegate task to agent.

- **Agent:** `$1`
- **Task:** `${@:2}`

## Instructions

1. Use the `subagent` tool to delegate the task to the agent.
1. Return an optimized summary of the subagent result using elegant,
   idiomatic markdown.
1. Stop. Perform no further operations.

## Rules

- Invoke the agent immediately.
- Don't perform any operations before invocation.
- Refine, `consolidate`, and optimize the task text for agent, token,
  context efficiency:
