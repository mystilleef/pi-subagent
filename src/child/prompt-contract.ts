export const SUBAGENT_RESULT_CONTRACT = `
- Always present results unchanged to the main agent.
- End your final response with exactly one line:
  - Outcome: <short, single, compact lower-case sentence>.
  - Outcome summarizes the result of your task in a single sentence.
`;

export function appendSubagentResultContract(prompt: string): string {
  return `${prompt}\n\n${SUBAGENT_RESULT_CONTRACT}`;
}
