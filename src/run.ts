import type { SubagentDetails } from "./types.js";
import { renderSubagentResult, type SubagentTheme } from "./ui.js";

export function renderSubagentResultMessage(
  message: { content?: unknown; details?: unknown },
  _options: { expanded: boolean },
  theme: SubagentTheme,
) {
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content)
        ? (message.content as { type: string; text?: string }[])
        : [];
  const details = message.details as SubagentDetails | undefined;
  const bodyOverride = content.find((item) => item.type === "text")?.text;
  return renderSubagentResult(
    { content, details },
    theme,
    undefined,
    bodyOverride,
  );
}
