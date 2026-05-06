import type { SingleResult } from "./types.js";

export const FEEDBACK_UI_SUMMARY_MAX_CHARS = 120;

const FEEDBACK_UI_GENERIC_CANDIDATES = new Set([
  "cause",
  "done",
  "next",
  "output",
  "project summary",
  "result",
  "status",
  "success",
  "summary",
  "verification",
]);

const FEEDBACK_UI_LABEL_PATTERN =
  /^\s*(outcome|project summary|result|summary|status|output|message|error|check):\s*/i;

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

export function isTranscriptNoiseLine(line: string): boolean {
  return /^(?:(?:hello|hi|hey)(?:[!,.?:;]+|\s|$)|reasoning:|raw log:|apolog(?:y|ies)|sorry\b)/i.test(
    line,
  );
}

export function isFailureDiagnosticLine(line: string): boolean {
  return /^(?:at\s+|error:|failed:|failure:|exception:|traceback\b|caused by:)/i.test(
    line,
  );
}

export function filterOutputLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) => l && !isTranscriptNoiseLine(l) && !isFailureDiagnosticLine(l),
    );
}

export function formatSubagentResultForParent(result: SingleResult): string {
  return filterOutputLines(result.finalOutput).join("\n");
}

export function summarizeFeedbackUiFinalOutput(finalOutput: string): string {
  const candidates = finalOutput
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((candidate) => normalizeFeedbackUiSummaryCandidate(candidate))
    .filter(({ text }) => hasSummaryValue(text));
  const selected =
    candidates.find(({ label }) => label === "outcome") ??
    candidates.find(({ label }) => label) ??
    candidates[0];
  return truncateFeedbackUiSummary(
    (selected?.text ?? "completed task").toLowerCase(),
  );
}

type FeedbackUiSummaryCandidate = {
  text: string;
  label: string | null;
};

function normalizeFeedbackUiSummaryCandidate(
  candidate: string,
): FeedbackUiSummaryCandidate {
  const unwrapped = candidate
    .replace(/^\s*```[\w-]*\s*/, "")
    .replace(/\s*```\s*$/, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*`{1,3}([^`]+)`{1,3}\s*$/, "$1")
    .replace(/^\s*\*\*([^*]+)\*\*\s*$/, "$1")
    .replace(/^\s*__([^_]+)__\s*$/, "$1");
  const label =
    unwrapped.match(FEEDBACK_UI_LABEL_PATTERN)?.[1]?.toLowerCase() ?? null;
  const text = normalizeSummaryValue(
    normalizeSummaryValue(
      unwrapped.replace(FEEDBACK_UI_LABEL_PATTERN, ""),
    ).replace(/[\s.!,;:—–-]+$/g, ""),
  );
  return { text, label };
}

function hasSummaryValue(candidate: string): boolean {
  const normalized = candidate.toLowerCase();
  return (
    !!normalized &&
    !FEEDBACK_UI_GENERIC_CANDIDATES.has(normalized) &&
    /[a-z]/i.test(candidate) &&
    /\s/.test(candidate)
  );
}

function truncateFeedbackUiSummary(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= FEEDBACK_UI_SUMMARY_MAX_CHARS) return value;
  return `${characters.slice(0, FEEDBACK_UI_SUMMARY_MAX_CHARS - 1).join("")}…`;
}
