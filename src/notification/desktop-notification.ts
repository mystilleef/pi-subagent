/**
 * Desktop notification model, formatting, and environment parsing.
 *
 * Defines the notification request shape, request metadata, message text
 * generation, duration formatting, and opt-out env parsing behind a small
 * testable boundary. No platform delivery logic lives here.
 */

import { formatElapsed } from "../progress/progress-format.js";
import type {
  ProgressStatus,
  SubagentProgressState,
} from "../progress/progress-state.js";

export const NOTIFICATION_TITLE = "Pi Subagent";

export interface NotificationMetadata {
  agent: string;
  status: ProgressStatus;
  instanceName?: string;
  durationMs: number;
  timestamp: string;
}

export interface NotificationRequest {
  title: string;
  body: string;
  urgency: "normal" | "critical";
  timeoutMs: number;
  metadata?: NotificationMetadata;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function isDesktopNotificationsEnabled(
  env?: Partial<NodeJS.ProcessEnv>,
): boolean {
  const raw = (env ?? process.env).PI_SUBAGENT_DESKTOP_NOTIFICATIONS;
  if (raw === undefined || raw === "") return true;
  return raw !== "0";
}

export function isPerJobNotificationEnabled(
  env?: Partial<NodeJS.ProcessEnv>,
): boolean {
  const raw = (env ?? process.env).PI_SUBAGENT_NOTIFY_PER_JOB;
  return raw === "1";
}

export function deriveDurationMs(
  state: SubagentProgressState,
  now?: () => number,
): number {
  if (state.durationMs !== undefined) return state.durationMs;
  return (now ? now() : Date.now()) - state.startTime;
}

export function formatNotificationBody(
  agent: string,
  status: ProgressStatus,
  durationMs: number,
): string {
  const duration = formatElapsed(durationMs);
  if (status === "error") return `${agent} failed after ${duration}`;
  return `${agent} finished in ${duration}`;
}

export function buildNotificationRequest(
  state: SubagentProgressState,
  now?: () => number,
): NotificationRequest {
  const clock = now ?? Date.now;
  let reading: number | undefined;
  const readClockOnce = (): number => {
    if (reading === undefined) reading = clock();
    return reading;
  };
  const durationMs = deriveDurationMs(state, readClockOnce);
  const metadata: NotificationMetadata = {
    agent: state.agent,
    status: state.status,
    ...(state.instanceName ? { instanceName: state.instanceName } : {}),
    durationMs,
    timestamp: new Date(readClockOnce()).toISOString(),
  };
  return {
    title: NOTIFICATION_TITLE,
    body: formatNotificationBody(state.agent, state.status, durationMs),
    urgency: state.status === "error" ? "critical" : "normal",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    metadata,
  };
}
