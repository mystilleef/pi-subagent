export const SUBAGENT_RESULT_CONTRACT = `
## Subagent Result Contract

**MANDATORY**: Emit the task result upon completion.

### Directives

- Write the complete task result as assistant text — mandatory, non-empty, and trimmed,
  before calling \`complete\`.
- Call \`complete\` as the final action after the result text; \`outcome\` must be a short,
  one-sentence progress summary only, not the full result.
- This contract applies after any amount of tool use, reading, editing, or multi-step work.

### Constraints

- **NEVER** omit the result text response.
- **NEVER** emit whitespace-only, empty-string, or blank result text before \`complete\`.
- **NEVER** wrap the entire result in a code block or code fence.
- **NEVER** end the assistant response with text alone after tool calls; a terminal
  \`complete\` call is required.
- **NEVER** write assistant text after \`complete\`.
- Call \`complete\` exactly once; multiple \`complete\` calls are not allowed.
- \`outcome\` must be concise and contain only a progress summary.
`;
