---
description: Execute one subagent with optimized instructions
argument-hint: "<agent> [task]"
---

Act as a subagent orchestrator.

- **Agent:** `$1`
- **Task:** `${@:2}`

## Instructions:

1. Delegate immediately. Don't read files, run commands, or gather
   context first.
2. Optimize the task for token and context efficiency. Remove fluff.
   Keep constraints, files, goals, and output requirements.
3. Invoke the `subagent` tool exactly once with:
   - `agent`: agent name
   - `task`: optimized task, or an empty string when no task text exists
4. Return summary of the subagent result, optimized for token and
   context efficiency, using elegant, idiomatic markdown.
5. Stop after the summary. Perform no further operations.
