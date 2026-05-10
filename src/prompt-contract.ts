export const SUBAGENT_RESULT_CONTRACT = `
- Don't summarize tasks that have a standardized result output.
- For tasks that don't have a standard result output,
  use context to decide whether to summarize task result.
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
