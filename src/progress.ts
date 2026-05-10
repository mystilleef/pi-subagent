import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import {
  getProgressState,
  type ProgressStatus,
  type SubagentProgressState,
} from "./progress-state.js";
import type { SubagentTheme, ThemeBg } from "./ui.js";

export { makeToolPreview } from "./normalize.js";
export {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  makeTaskPreview,
  type ProgressStatus,
  patchProgressState,
  resetProgressStore,
  type SubagentProgressState,
} from "./progress-state.js";

export function formatElapsed(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  const unit = count >= 1_000_000 ? "M" : "k";
  const divisor = count >= 1_000_000 ? 1_000_000 : 1000;
  return `${trimTrailingZero((count / divisor).toFixed(1))}${unit}`;
}

export function formatHeaderStats(state: SubagentProgressState): string {
  const elapsedMs = state.durationMs ?? Date.now() - state.startTime;
  const toolLabel = state.toolCount === 1 ? "tool" : "tools";
  return `${state.toolCount} ${toolLabel} · ${formatContextPercent(state)} ctx · ${formatElapsed(elapsedMs)}\n`;
}

function formatContextPercent(state: SubagentProgressState): string {
  const denominator = state.contextWindowTokens;
  if (
    typeof denominator !== "number" ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  )
    return "--%";
  const numerator = state.contextTokens;
  if (
    typeof numerator !== "number" ||
    !Number.isFinite(numerator) ||
    numerator <= 0
  )
    return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

export function renderSubagentProgress(
  message: {
    customType?: string;
    content?: unknown;
    display?: boolean;
    details?: unknown;
  },
  options: { expanded: boolean },
  theme: SubagentTheme,
): Component | undefined {
  const details = message.details as { requestId?: string } | undefined;
  const requestId = details?.requestId;
  if (!requestId || !getProgressState(requestId)) return undefined;
  return new DynamicSubagentProgressText(requestId, options, theme);
}

class DynamicSubagentProgressText implements Component {
  constructor(
    private readonly requestId: string,
    private readonly options: { expanded: boolean },
    private readonly theme: SubagentTheme,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const state = getProgressState(this.requestId);
    if (!state) return [];
    const text = formatProgressText(this.requestId, this.options, this.theme);
    const bg = getProgressBackground(state.status);
    return text
      ? new Text(text, 1, 1, (line) => this.theme.bg(bg, line)).render(width)
      : [];
  }
}

function getProgressBackground(status: ProgressStatus): ThemeBg {
  if (status === "running") return "toolPendingBg";
  if (status === "success") return "toolSuccessBg";
  return "toolErrorBg";
}

function formatProgressText(
  requestId: string,
  options: { expanded: boolean },
  theme: SubagentTheme,
): string | undefined {
  const state = getProgressState(requestId);
  if (!state) return undefined;
  const statusColorMap: Record<ProgressStatus, ThemeColor> = {
    success: "success",
    error: "error",
    cancelled: "error",
    running: "accent",
  };
  const iconMap: Record<ProgressStatus, string> = {
    success: "✓",
    error: "✗",
    cancelled: "⊘",
    running: "⟳",
  };
  const statusColor = statusColorMap[state.status];
  const icon = iconMap[state.status];
  const headerStats = formatHeaderStats(state);
  const header =
    theme.fg(statusColor, icon) +
    " " +
    theme.fg("toolTitle", theme.bold(state.agent)) +
    " " +
    theme.fg("dim", `[${state.status}]`) +
    " " +
    theme.fg("muted", headerStats);
  const taskLine = `\n  ${theme.fg("dim", state.taskPreview)}`;
  if (state.status === "running") {
    const toolLine = state.lastToolPreview
      ? `\n  ${formatRunningToolPreview(state.lastToolPreview, theme)}`
      : "";
    return options.expanded ? header + toolLine + taskLine : header + toolLine;
  }
  if (state.status === "error" || state.status === "cancelled") {
    const errorLine = state.errorText
      ? `\n  ${theme.fg("error", state.errorText)}`
      : "";
    return options.expanded
      ? header + errorLine + taskLine
      : header + errorLine;
  }
  if (state.status === "success") {
    const output = state.finalOutput?.trim().split("\n")[0] ?? "";
    if (!options.expanded) {
      const preview = output ? `\n  ${theme.fg("toolOutput", output)}` : "";
      return header + preview;
    }
    const outputSection = output
      ? `\n${theme.fg("muted", "─── Output ───")}\n${theme.fg("toolOutput", output)}`
      : `\n${theme.fg("muted", "(no output)")}`;
    return header + taskLine + outputSection;
  }
  return header;
}

function formatRunningToolPreview(
  preview: string,
  theme: SubagentTheme,
): string {
  const separatorIndex = preview.indexOf(":");
  const arrow = theme.fg("muted", "→");
  if (separatorIndex === -1) return `${arrow} ${theme.fg("accent", preview)}`;
  const toolName = preview.slice(0, separatorIndex);
  const rest = preview.slice(separatorIndex);
  return `${arrow} ${theme.fg("accent", toolName)}${theme.fg("dim", rest)}`;
}
