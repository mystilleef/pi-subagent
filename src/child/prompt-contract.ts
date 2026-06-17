export const SUBAGENT_RESULT_CONTRACT = `
- Call the complete tool as your final action with a short, single-sentence outcome.
- Always present unmodified result to calling agent.
`;

export function appendSubagentResultContract(prompt: string): string {
  return `${prompt}\n\n${SUBAGENT_RESULT_CONTRACT}`;
}
