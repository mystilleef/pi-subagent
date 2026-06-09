const TERMINAL_SENTENCE_MAX_CHARS = 100;

export function normalizeSummaryValue(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  const wrapper = normalized.match(/^(?:`([^`]+)`|\*\*([^*]+)\*\*)$/);
  if (wrapper) return (wrapper[1] ?? wrapper[2] ?? "").trim();
  return normalized;
}

const SECRET_KEY_RE = /secret|token|password|passwd|credential|auth/i;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function extractSemanticToolTarget(
  args: Record<string, unknown>,
  forceJson = false,
): string {
  if (forceJson) return JSON.stringify(args);
  const semanticKeys = [
    "command",
    "path",
    "agent",
    "query",
    "url",
    "action",
    "name",
  ];
  for (const key of semanticKeys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  for (const key of Object.keys(args)) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (SECRET_KEY_RE.test(key)) continue;
    if (value.length > 60 || JWT_RE.test(value)) continue;
    return value;
  }
  return "";
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
  const withoutStatusPrefix = unwrapped.replace(
    /^(?:(?:success|failure):\s*)+/i,
    "",
  );
  const withoutLabel = withoutStatusPrefix.replace(
    /^\s*(?:status|summary|result|output|message|error|check|outcome|project summary):\s+/i,
    "",
  );
  const normalizedOnce = normalizeSummaryValue(withoutLabel);
  const stripped = normalizedOnce.replace(/[\s.!,;:—–-]+$/g, "");
  const collapsed = normalizeSummaryValue(stripped);
  return truncateText(collapsed, limit);
}

const TOOL_PREVIEW_MAX_CHARS = 120;

export function normalizeAndTruncate(
  text: string,
  limit = TOOL_PREVIEW_MAX_CHARS,
): string {
  return truncateText(normalizeSummaryValue(text), limit);
}

export function makeToolPreview(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args || Object.keys(args).length === 0) return toolName;
  const target = normalizeSummaryValue(extractSemanticToolTarget(args));
  if (!target) return toolName;
  return normalizeAndTruncate(`${toolName}: ${target}`);
}

export function isStatusOnlySuccess(value: string): boolean {
  return /^(?:success|done)$/i.test(value.trim());
}

export function isStatusOnlyFailure(value: string): boolean {
  return /^(?:failure|failed|error)$/i.test(value.trim());
}
