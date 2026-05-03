---
description: Execute one subagent with optimized instructions
argument-hint: "<agent> [task]"
---

Delegate one task to one subagent.

- **Agent:** `$1`
- **Task:** `${@:2}`

## Instructions

1. Invoke `subagent` exactly once. Don't read files, run commands, or
   gather context first.
2. Optimize task text for token/context efficiency:
   - keep goals, constraints, paths, and output requirements;
   - remove fluff.
3. Pass:
   - `agent`: `$1`
   - `task`: optimized task, or `""` when no task text exists
4. Return an optimized summary of the subagent result using elegant,
   idiomatic markdown.
5. Stop. Perform no further operations.
