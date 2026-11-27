/**
 * Webhook transport for completion alerts.
 *
 * Resolves the single env-configured receiver and posts the provider-neutral
 * envelope once through native `fetch`, bounded by one unreferenced abort
 * timer. Every outcome—2xx, non-2xx, rejection, timeout abort, body-cancel
 * rejection, or a synchronous throw—resolves without diagnostics or host UI.
 */

import { type DeliveryDependencies, resolveDeliveryDeps } from "./delivery.js";
import type { NotificationRequest } from "./desktop-notification.js";
import { buildWebhookPayload } from "./webhook-payload.js";

/** Abort window, mirroring the desktop notification timeout. */
const WEBHOOK_TIMEOUT_MS = 5000;

const WEBHOOK_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Resolves the configured receiver to its normalized `URL.href`, or
 * `undefined` when the setting is absent, empty after trimming, unparseable,
 * non-HTTP(S), or hostless.
 */
export function resolveWebhookUrl(
  env?: Partial<NodeJS.ProcessEnv>,
): string | undefined {
  const raw = (env ?? process.env).PI_SUBAGENT_WEBHOOK_URL;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (!WEBHOOK_PROTOCOLS.has(url.protocol)) return undefined;
  if (url.hostname === "") return undefined;
  return url.href;
}

/**
 * Delivers the request's projection to the resolved receiver, or sends
 * nothing when no receiver resolves or the request carries no metadata.
 * Never throws and never writes output.
 *
 * `resolvedUrl` lets callers that already resolved the receiver via
 * {@link resolveWebhookUrl} skip a second parse.
 */
export async function deliverWebhookNotification(
  request: NotificationRequest,
  deps?: DeliveryDependencies,
  resolvedUrl?: string,
): Promise<void> {
  const url = resolvedUrl ?? resolveWebhookUrl();
  if (url === undefined) return;
  const payload = buildWebhookPayload(request);
  if (payload === undefined) return;
  const resolved = resolveDeliveryDeps(deps);
  const fetchFn = resolved.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    resolved.webhookTimeoutMs ?? WEBHOOK_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: controller.signal,
    });
    // The timer bounds the request only: settlement ends it even while the
    // response body's cancellation stays pending.
    clearTimeout(timer);
    const body = response.body;
    if (body) await body.cancel().catch(() => {});
  } catch {
    /* Best-effort delivery: every failure settles silently. */
  } finally {
    clearTimeout(timer);
  }
}
