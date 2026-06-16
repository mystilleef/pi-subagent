/**
 * Extracts structured outcomes from complete tool calls in message arrays.
 * Handles the complete tool's terminate: true protocol for subagent completion.
 */

import type { Message } from "@earendil-works/pi-ai";

type CompleteCall = { id: string; outcome?: string | undefined };
type CompleteResult = { isError: boolean; outcome?: string | undefined };

/**
 * Safely extracts a trimmed outcome string from an unknown source object.
 * Returns undefined if the source is not an object with a string "outcome" property,
 * or if the outcome is whitespace-only.
 */
export function getOutcomeString(source: unknown): string | undefined {
  if (
    source &&
    typeof source === "object" &&
    typeof (source as Record<string, unknown>)["outcome"] === "string"
  ) {
    const outcome = (source as Record<string, unknown>)["outcome"] as string;
    return outcome.trim() || undefined;
  }
  return undefined;
}

/**
 * Extracts the latest valid outcome from complete tool calls in messages.
 * Searches for complete tool calls and their results, then returns the outcome
 * from the most recent successful call that has a valid outcome string.
 *
 * Priority:
 * 1. Outcome from the toolResult details (if successful)
 * 2. Outcome from the assistant's arguments (fallback)
 *
 * Returns undefined if no valid outcome is found.
 */
export function getLatestOutcomeFromMessages(
  messages: Message[] | undefined,
): string | undefined {
  if (!messages?.length) return undefined;

  const calls: CompleteCall[] = [];
  const callIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== "toolCall" || part.name !== "complete" || !part.id)
        continue;
      calls.push({ id: part.id, outcome: getOutcomeString(part.arguments) });
      callIds.add(part.id);
    }
  }

  const results = new Map<string, CompleteResult>();
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    // pi emits toolCallId on standard toolResult messages, but some event shapes (e.g. agent_end
    // re-emitted messages) carry id instead — both must be checked to avoid missing outcomes.
    const tId = msg.toolCallId || (msg as unknown as { id?: string }).id;
    if (!tId || !callIds.has(tId)) continue;
    results.set(tId, {
      isError: !!msg.isError,
      outcome: getOutcomeString(msg.details),
    });
  }

  for (const { id, outcome: callOutcome } of calls.reverse()) {
    const result = results.get(id);
    if (!result || result.isError) continue;
    if (result.outcome) return result.outcome;
    if (callOutcome) return callOutcome;
  }
  return undefined;
}
