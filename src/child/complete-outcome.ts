import type { Message } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { completeParams } from "./complete-extension.js";

export function getOutcomeString(source: unknown): string | undefined {
  if (Value.Check(completeParams, source)) {
    return source.outcome.trim();
  }
  return undefined;
}

/**
 * Extracts the latest valid outcome from complete tool call arguments in messages.
 *
 * Reads from call arguments (message_end) rather than tool results (tool_result_end)
 * because tool_result_end is unreliable when terminate: true causes pi to exit before
 * delivering it. Call arguments are always delivered via message_end.
 */
export function getLatestOutcomeFromMessages(
  messages: Message[] | undefined,
): string | undefined {
  if (!messages?.length) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j];
      if (part?.type !== "toolCall") continue;
      if (part.name !== "complete" || !part.id) continue;
      const outcome = getOutcomeString(part.arguments);
      if (outcome) return outcome;
    }
  }
  return undefined;
}
