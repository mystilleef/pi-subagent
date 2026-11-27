/**
 * Provider-neutral JSON webhook envelope projection.
 *
 * Projects a notification request into the canonical webhook body, carrying
 * completion metadata only. Execution content—prompts, task previews, final
 * output, error text, tool arguments, transcripts, and stderr—never crosses
 * this boundary, in debug mode or otherwise.
 */

import type { ProgressStatus } from "../progress/progress-state.js";
import type { NotificationRequest } from "./desktop-notification.js";

export interface WebhookPayload {
  event: "subagent.completed" | "subagent.failed";
  title: string;
  message: string;
  text: string;
  content: string;
  agent: string;
  status: ProgressStatus;
  durationMs: number;
  timestamp: string;
  instanceName?: string;
  urgency: "normal" | "critical";
}

export function buildWebhookPayload(
  request: NotificationRequest,
): WebhookPayload | undefined {
  const metadata = request.metadata;
  if (metadata === undefined) return undefined;
  const failed = metadata.status === "error";
  const text = `${request.title}: ${request.body}`;
  return {
    event: failed ? "subagent.failed" : "subagent.completed",
    title: request.title,
    message: request.body,
    text,
    content: text,
    agent: metadata.agent,
    status: metadata.status,
    durationMs: metadata.durationMs,
    timestamp: metadata.timestamp,
    ...(metadata.instanceName ? { instanceName: metadata.instanceName } : {}),
    urgency: failed ? "critical" : "normal",
  };
}
