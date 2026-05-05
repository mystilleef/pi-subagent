import type { SingleResult } from "./types.js";

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
  }
  return JSON.stringify(args);
}

export function isTranscriptNoiseLine(line: string): boolean {
  return /^(?:hello|hi|hey|reasoning:|raw log:|apolog(?:y|ies)|sorry\b)/i.test(
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
