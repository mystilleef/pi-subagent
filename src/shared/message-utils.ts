/**
 * Message processing utilities for subagent results.
 * Handles assistant message extraction, error detection, and failure判定.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./types.js";

export function findLastAssistantTextMessage(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg?.role === "assistant" &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (c) =>
          c.type === "text" &&
          typeof c.text === "string" &&
          c.text.trim().length > 0,
      )
    ) {
      return i;
    }
  }
  return -1;
}

export function extractFinalOutputFromMessages(messages: Message[]): string {
  const lastAsstIdx = findLastAssistantTextMessage(messages);
  if (lastAsstIdx < 0) return "";
  const content = messages[lastAsstIdx]?.content;
  if (!Array.isArray(content)) return "";
  const lastText = content.findLast((p) => p.type === "text");
  return lastText?.type === "text" ? (lastText.text ?? "") : "";
}

export function detectMessageError(messages: Message[]): boolean {
  const lastAssistantIdx = findLastAssistantTextMessage(messages);
  const from = lastAssistantIdx >= 0 ? lastAssistantIdx + 1 : 0;
  for (let i = messages.length - 1; i >= from; i--) {
    const msg = messages[i];
    if (msg?.role === "toolResult" && msg.isError) return true;
  }
  return false;
}

export function hasSubagentFailed(result: SingleResult): boolean {
  if (result.outcome?.trim()) return false;
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    Boolean(result.errorMessage?.trim()) ||
    detectMessageError(result.messages ?? [])
  );
}
