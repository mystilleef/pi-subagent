export const SUBAGENT_RESULT_CONTRACT = `
- Write your result as a text response.
- Don't wrap results in code blocks.
- Call the complete tool as your final action with a short, single-sentence outcome.
- Return result; add no commentary.
`;

export function appendSubagentResultContract(prompt: string): string {
  return `${prompt}\n\n${SUBAGENT_RESULT_CONTRACT}`;
}
