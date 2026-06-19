export const SUBAGENT_RESULT_CONTRACT = `
- Call the complete tool as your final action with a short, single-sentence outcome.
- Always present unmodified result to calling agent.
- Never add additional commentary or verbiage to the result.
`;

export function appendSubagentResultContract(prompt: string): string {
  return `${prompt}\n\n${SUBAGENT_RESULT_CONTRACT}`;
}
