export const SUBAGENT_RESULT_CONTRACT = `
## Subagent Result Contract

**MANDATORY**: Emit the task result upon completion.

### Directives

- Write result as a text response.
- Emit result to the calling agent without commentary.
- Call the complete tool as the final action, providing a short, single-sentence outcome.

### Constraints

- **NEVER** wrap result in code blocks.
`;

export function appendSubagentResultContract(prompt: string): string {
  return `${prompt}\n\n${SUBAGENT_RESULT_CONTRACT}`;
}
