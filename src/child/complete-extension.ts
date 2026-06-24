import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const completeParams = Type.Object({
  outcome: Type.String({
    description:
      "A short, single-sentence summary of the task outcome. Keep it concise, brief, and under 100 characters.",
    minLength: 1,
    pattern: "^[\\s\\S]*\\S[\\s\\S]*$",
  }),
});

export const completeTool = defineTool({
  name: "complete",
  label: "Complete",
  description:
    "Complete the task and report the structured outcome. Call this as your final action.",
  promptSnippet: "Complete the task and report the structured outcome.",
  promptGuidelines: [
    "Call complete as your final action to report the outcome after completing the task.",
  ],
  parameters: completeParams,
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: params.outcome }],
      details: {
        outcome: params.outcome,
      },
      terminate: true,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(completeTool);
}
