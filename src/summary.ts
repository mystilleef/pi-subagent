import type { SingleResult } from "./types.js";

export type SummaryLabel =
  | "Outcome"
  | "Changed"
  | "Verification"
  | "Next"
  | "Cause";

export const SUMMARY_LABELS: SummaryLabel[] = [
  "Outcome",
  "Changed",
  "Verification",
  "Next",
  "Cause",
];

export function normalizeLabel(raw: string): SummaryLabel | undefined {
  if (raw.toLowerCase() === "evidence") return "Verification";
  return SUMMARY_LABELS.find(
    (label) => label.toLowerCase() === raw.toLowerCase(),
  );
}

export function extractSummaryLabels(
  output: string,
): Partial<Record<SummaryLabel, string>> {
  const summary: Partial<Record<SummaryLabel, string>> = {};
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  let active: SummaryLabel | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(
      /^#{1,6}\s+(Outcome|Changed|Verification|Evidence|Next|Cause)(?:\s*:\s*|\s+)?(.*)$/i,
    );
    const inline =
      line.match(
        /^(?:[-*]\s*)?(?:\*\*)?(Outcome|Changed|Verification|Evidence|Next|Cause)\s*:\*\*\s*(.*)$/i,
      ) ??
      line.match(
        /^(?:[-*]\s*)?(?:\*\*)?(Outcome|Changed|Verification|Evidence|Next|Cause)(?:\*\*)?\s*:\s*(.*)$/i,
      );
    if (heading) {
      active = normalizeLabel(heading[1] ?? "");
      const value = heading[2]?.trim();
      if (active && value) summary[active] = value;
      continue;
    }
    if (inline) {
      active = normalizeLabel(inline[1] ?? "");
      const value = inline[2]?.trim();
      if (active && value) summary[active] = value;
      continue;
    }
    if (active && shouldAppendSummaryContinuation(line, summary[active])) {
      summary[active] = summary[active] ? `${summary[active]} ${line}` : line;
    }
  }
  return summary;
}

function looksLikePath(value: string): boolean {
  return /^(?:\.{1,2}\/|\/|[\w.-]+\/|[\w.-]+\.[\w.-]+$)/.test(value);
}

export function compactChangedPathList(value: string): string {
  const paths = value.split(",").map((part) => part.trim());
  if (paths.length <= 4 || paths.some((path) => !looksLikePath(path)))
    return value;
  return `${paths.length} files: ${paths.slice(0, 4).join(", ")}, …`;
}

export function normalizeSummaryValue(
  value: string,
  label?: SummaryLabel,
): string {
  let normalized = value.trim().replace(/\s+/g, " ");
  const wrapper = normalized.match(/^(?:`([^`]+)`|\*\*([^*]+)\*\*)$/);
  if (wrapper) normalized = (wrapper[1] ?? wrapper[2] ?? "").trim();
  if (label === "Changed") normalized = compactChangedPathList(normalized);
  return normalized;
}

export function isNoOpSummaryValue(value: string): boolean {
  return /^(?:none|n\/a|na|nothing|no changes|unchanged|not applicable)$/i.test(
    value.trim(),
  );
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
  }
  return JSON.stringify(args);
}

function resultFailed(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    !!result.errorMessage
  );
}

function shouldAppendSummaryContinuation(
  line: string,
  current: string | undefined,
): boolean {
  if (current && isNoOpSummaryValue(current)) return false;
  if (isTranscriptNoiseLine(line) || isFailureDiagnosticLine(line))
    return false;
  if (/^[A-Z][A-Za-z ]{1,30}:\s+/.test(line)) return false;
  return true;
}

function isTranscriptNoiseLine(line: string): boolean {
  return /^(?:hello|hi|hey|reasoning:|raw log:|apolog(?:y|ies)|sorry\b)/i.test(
    line,
  );
}

function isFailureDiagnosticLine(line: string): boolean {
  return /^(?:at\s+|error:|failed:|failure:|exception:|traceback\b|caused by:)/i.test(
    line,
  );
}

function cleanFailureCause(value: string): string {
  return normalizeSummaryValue(
    value.replace(
      /^\s*(?:at\s+|error:|failed:|failure:|exception:|caused by:)\s*/i,
      "",
    ),
  );
}

function extractStackCause(output: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => /^at\s+/i.test(entry));
  return line ? cleanFailureCause(line) : undefined;
}

function extractRawErrorCause(output: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => /^(?:error|failed|failure|exception):\s+/i.test(entry));
  return line ? cleanFailureCause(line) : undefined;
}

function fallbackFailureCause(result: SingleResult): string | undefined {
  return (
    result.errorMessage ||
    extractRawErrorCause(result.stderr) ||
    extractStackCause(result.stderr) ||
    extractRawErrorCause(result.finalOutput) ||
    extractStackCause(result.finalOutput)
  );
}

export function formatSemanticFallbackOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const labeledResult = lines.find((line) => /^result:\s+/i.test(line));
  if (labeledResult) return labeledResult;
  const statusLine = lines.find((line) =>
    /^(?:success|failure|failed|error):\s+/i.test(line),
  );
  if (statusLine) return statusLine;
  const checkLine = lines.find((line) =>
    /(?:\b(?:bun|npm|pnpm|yarn)\s+(?:test|check|verify)\b|\b(?:test|check|verify)\b.*\b(?:pass|fail|passed|failed)\b)/i.test(
      line,
    ),
  );
  if (checkLine) return checkLine;
  return lines.find((line) => !isTranscriptNoiseLine(line)) ?? "";
}

export function formatSubagentResultForParent(result: SingleResult): string {
  const summary = extractSummaryLabels(result.finalOutput);
  const failed = resultFailed(result);
  const labels: SummaryLabel[] = failed
    ? ["Outcome", "Cause", "Verification", "Next"]
    : ["Outcome", "Changed", "Verification", "Next"];
  const seenValues = new Set<string>();
  const lines = labels.flatMap((label) => {
    const rawValue =
      label === "Cause" && !summary.Cause
        ? fallbackFailureCause(result)
        : summary[label];
    const value = rawValue ? normalizeSummaryValue(rawValue, label) : "";
    const key = value.toLowerCase();
    if (!value || isNoOpSummaryValue(value) || seenValues.has(key)) return [];
    seenValues.add(key);
    return `${label}: ${value}`;
  });
  if (lines.length) return lines.join("\n");
  return formatSemanticFallbackOutput(result.finalOutput);
}
