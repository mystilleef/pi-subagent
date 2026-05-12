export const SUBAGENT_RESULT_CONTRACT = `
- Always present raw result to main agent.
- Use brief, precise, concise prose while maintaining clarity.
- Optimize prose for token and context efficiency.
- Add an empty line between paragraphs, headings and sections.
- Use elegant, well-structured, idiomatic markdown.
- End your final response with exactly one line:
  - Outcome: <short, single, compact lower-case sentence>.
  - Outcome summarizes the result of your task in a single sentence.
`;

export function appendSubagentResultContract(prompt: string): string {
  return `${prompt}\n\n${SUBAGENT_RESULT_CONTRACT}`;
}
