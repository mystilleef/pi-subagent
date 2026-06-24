export const SUBAGENT_RESULT_CONTRACT = `
## Subagent Result Contract

**MANDATORY**: Emit the task result upon completion.

### Directives

- Write the complete result as a text response — mandatory, before calling \`complete\`.
- Call \`complete\` as the final action; \`outcome\` carries a one-sentence progress
  summary only, not the result.

### Constraints

- **NEVER** omit the text response.
- **NEVER** wrap the entire result in a code block.
`;

export function appendSubagentResultContract(prompt: string): string {
  return `${prompt}\n\n${SUBAGENT_RESULT_CONTRACT}`;
}
