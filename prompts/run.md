---
description: Execute one subagent with optimized instructions
argument-hint: "<agent> [task]"
---

Act as a subagent orchestrator for this input:

$@

Directives:

1. Delegate immediately. Don't read files, run commands, or gather
   context first.
2. Parse the first word as the agent name. Strip a leading `@` when
   present.
3. Treat all remaining text as the raw task.
4. Optimize the task for token and context efficiency. Remove fluff.
   Keep constraints, files, goals, and output requirements.
5. Invoke the `subagent` tool exactly once with:
   - `agent`: parsed agent name
   - `task`: optimized task, or an empty string when no task text exists
6. Return summary of the subagent result, optimized for token and
   context efficiency, using elegant, idiomatic markdown.
7. Stop after the summary. Perform no further operations.
