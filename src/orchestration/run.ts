import { renderSubagentResult, type SubagentTheme } from "../output/ui.js";
import type { SubagentDetails } from "../shared/types.js";

/**
 * Pi message renderer adapter for `"subagent-result"` messages.
 *
 * Normalizes the Pi message payload into the canonical shape expected by
 * {@link renderSubagentResult}, bridging the gap between Pi's
 * `MessageRenderer` contract and the internal result component.
 *
 * ## Rationale
 *
 * Pi's message renderer interface passes `content` as `unknown` — it can be
 * a raw string or an array of content blocks from a tool call. The internal
 * `renderSubagentResult` expects a uniform `{ type: string; text?: string }[]`
 * array. This adapter handles both shapes.
 *
 * The first text block is extracted as `bodyOverride`. When set, it
 * replaces the result body that `renderSubagentResult` would normally
 * extract from `details.results[0].finalOutput`. This lets callers
 * inject a pre-formatted summary (e.g., from `/run` summarization)
 * while keeping the details-derived header metadata intact.
 *
 * The `_options` parameter is part of Pi's `MessageRenderer` contract
 * but not consumed — the result card always renders at full width.
 *
 * @param message - Pi message with optional string/array content and details.
 *   `details` is cast to {@link SubagentDetails}; non-conforming payloads
 *   produce a fallback `"(no output)"` text block inside the callee.
 * @param _options - Unused; Pi `MessageRenderer` contract.
 * @param theme - TUI theme forwarded to `renderSubagentResult`.
 * @returns Rendered `Component` for the subagent result card.
 */
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
