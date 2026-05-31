export const TERMINAL_SENTENCE_MAX_CHARS = 100;

export function normalizeSummaryValue(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  const wrapper = normalized.match(/^(?:`([^`]+)`|\*\*([^*]+)\*\*)$/);
  if (wrapper) return (wrapper[1] ?? wrapper[2] ?? "").trim();
  return normalized;
}

export function extractSemanticToolTarget(
  toolName: string,
  args: Record<string, unknown>,
  forceJson = false,
): string {
  if (forceJson) return JSON.stringify(args);
  if (toolName === "bash" && typeof args.command === "string")
    return args.command;
  if (
    ["read", "write", "edit", "file_search"].includes(toolName) &&
    typeof args.path === "string"
  )
    return args.path;
  if (toolName === "subagent") {
    const parts = [];
    if (typeof args.agent === "string") parts.push(args.agent);
    if (typeof args.task === "string")
      parts.push(normalizeSummaryValue(args.task));
    if (typeof args.agentScope === "string") parts.push(`[${args.agentScope}]`);
    if (parts.length) return parts.join(" ");
    return JSON.stringify(args);
  }
  return "";
}

function stripTerminalStatusPrefixes(value: string): string {
  return value.replace(/^(?:(?:success|failure):\s*)+/i, "");
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

export function normalizeTerminalSentence(
  value: string,
  limit = TERMINAL_SENTENCE_MAX_CHARS,
): string {
  const unwrapped = value
    .replace(/^\s*(?:[-*>]\s*)+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*`{1,3}([^`]+)`{1,3}\s*$/, "$1")
    .replace(/^\s*\*\*([^*]+)\*\*\s*$/, "$1")
    .replace(/^\s*__([^_]+)__\s*$/, "$1");
  const withoutStatusPrefix = stripTerminalStatusPrefixes(unwrapped);
  const withoutLabel = withoutStatusPrefix.replace(
    /^\s*(?:status|summary|result|output|message|error|check|outcome|project summary):\s+/i,
    "",
  );
  const normalizedOnce = normalizeSummaryValue(withoutLabel);
  const stripped = normalizedOnce.replace(/[\s.!,;:—–-]+$/g, "");
  const collapsed = normalizeSummaryValue(stripped);
  return truncateText(collapsed, limit);
}

export const TOOL_PREVIEW_MAX_CHARS = 120;

export function makeToolPreview(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args || Object.keys(args).length === 0) return toolName;
  const target = normalizeSummaryValue(
    extractSemanticToolTarget(toolName, args),
  );
  if (!target) return toolName;
  return truncateText(
    normalizeSummaryValue(`${toolName}: ${target}`),
    TOOL_PREVIEW_MAX_CHARS,
  );
}

export function isStatusOnlySuccess(value: string): boolean {
  return /^(?:success|done)$/i.test(value.trim());
}

export function isStatusOnlyFailure(value: string): boolean {
  return /^(?:failure|failed|error)$/i.test(value.trim());
}
