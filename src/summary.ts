import { normalizeTerminalSentence } from "./normalize.js";
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

export function formatSubagentResultForParent(result: SingleResult): string {
  return result.finalOutput;
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
  return (selected?.text ?? "completed task").toLowerCase();
}

type FeedbackUiSummaryCandidate = {
  text: string;
  label: string | null;
};

function normalizeFeedbackUiSummaryCandidate(
  candidate: string,
): FeedbackUiSummaryCandidate {
  const label =
    candidate.match(FEEDBACK_UI_LABEL_PATTERN)?.[1]?.toLowerCase() ?? null;
  const text = normalizeTerminalSentence(
    candidate,
    FEEDBACK_UI_SUMMARY_MAX_CHARS,
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
