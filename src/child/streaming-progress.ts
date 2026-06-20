import type { Message } from "@earendil-works/pi-ai";
import { makeToolPreview, renderToolActivity } from "../progress/progress.js";
import { SENSITIVE_PATTERN } from "../progress/progress-format.js";
import { isToolCallPart } from "../progress/progress-state.js";
import type {
  OnUpdateCallback,
  StreamingProgress,
  SubagentDetails,
  ToolActivity,
} from "../shared/types.js";
import { findLastAssistantTextMessage } from "../shared/utils.js";
import type { RuntimeResult } from "./result-builder.js";

function findRecentMessagesAnchor(messages: Message[]): number {
  return findLastAssistantTextMessage(messages);
}

function sanitizeProgressPreview(preview: string, toolName: string): string {
  return SENSITIVE_PATTERN.test(preview) ? toolName : preview;
}

function deriveStreamingProgress(messages: Message[]): StreamingProgress {
  const toolCalls: { id: string; preview: string }[] = [];
  let lastToolPreview: string | undefined;
  let activeToolActivity: ToolActivity | undefined;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!isToolCallPart(part)) continue;
      const preview = sanitizeProgressPreview(
        makeToolPreview(part.name, part.arguments),
        part.name,
      );
      toolCalls.push({ id: part.id, preview });
      lastToolPreview = preview;
      activeToolActivity = { toolName: part.name, inputSummary: preview };
    }
  }
  const activityText = renderToolActivity(activeToolActivity);
  return {
    activeToolActivity,
    activityText,
    toolCalls,
    lastToolPreview,
  };
}

/**
 * Merge incoming tool activity with existing progress activity.
 * When tool names match, prefer richer inputSummary from incoming.
 * Otherwise, replace entirely with incoming activity.
 */
function mergeToolActivity(
  existing: ToolActivity | undefined,
  incoming: ToolActivity,
): ToolActivity {
  if (existing && existing.toolName === incoming.toolName) {
    const incomingSummary = incoming.inputSummary;
    const preferIncoming =
      incomingSummary && incomingSummary !== incoming.toolName;
    return {
      ...existing,
      inputSummary: preferIncoming ? incomingSummary : existing.inputSummary,
      instanceName: incoming.instanceName ?? existing.instanceName,
      child: incoming.child ?? existing.child,
    };
  }
  return incoming;
}

/**
 * Apply tool activity and result completion updates to progress state.
 * Handles merging of child events with parent activity tree.
 */
function applyActivityUpdates(
  progress: StreamingProgress,
  options: { toolActivity?: ToolActivity; toolResultCompleted?: boolean },
  previousActivity?: ToolActivity,
): void {
  if (options.toolResultCompleted && previousActivity) {
    progress.activeToolActivity = previousActivity;
    const renderedText = renderToolActivity(previousActivity);
    if (renderedText !== undefined) progress.activityText = renderedText;
    else delete progress.activityText;
  }
  if (options.toolActivity) {
    progress.activeToolActivity = mergeToolActivity(
      progress.activeToolActivity,
      options.toolActivity,
    );
    const renderedActivity = renderToolActivity(progress.activeToolActivity);
    if (renderedActivity !== undefined)
      progress.activityText = renderedActivity;
    else delete progress.activityText;
  }
  if (options.toolResultCompleted) {
    progress.toolResultCompleted = true;
  }
}

export type EmitUpdateFn = (options?: {
  toolActivity?: ToolActivity;
  toolResultCompleted?: boolean;
}) => void;

export function makeEmitUpdate(
  result: RuntimeResult,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (
    results: RuntimeResult[],
    options?: { includeMessages?: boolean; recentMessages?: Message[] },
  ) => SubagentDetails,
): EmitUpdateFn {
  return (options) => {
    const msgs = result.messages;
    const anchorIdx = findRecentMessagesAnchor(msgs);
    const recentMessages =
      anchorIdx >= 0 ? msgs.slice(anchorIdx) : msgs.slice(-5);
    const progress = deriveStreamingProgress(msgs);
    if (options) {
      applyActivityUpdates(
        progress,
        options,
        result.progress?.activeToolActivity,
      );
    }
    result.progress = progress;
    onUpdate?.({
      content: [
        { type: "text", text: progress.activityText ?? "(running...)" },
      ],
      details: makeDetails([result], {
        includeMessages: true,
        recentMessages,
      }),
    });
  };
}
