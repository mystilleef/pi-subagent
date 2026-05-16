import type {
  ExtensionCommandContext,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { getAllProgressStates, getProgressState } from "./progress-state.js";
import { listRunJobs } from "./run-registry.js";
import { renderRunsBoard, type SubagentTheme, type ThemeBg } from "./ui.js";

function makePlainTheme(): SubagentTheme {
  return {
    fg: (_c: ThemeColor, t: string) => t,
    bg: (_c: ThemeBg, t: string) => t,
    bold: (text: string) => text,
  };
}

export async function jobsCommandHandler(
  ctx: ExtensionCommandContext,
  _args: string,
): Promise<void> {
  const activeJobs = listRunJobs();
  const activeRequestIds = new Set(activeJobs.map((j) => j.requestId));
  const activeStates = activeJobs
    .map((j) => getProgressState(j.requestId))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const allStates = getAllProgressStates();
  const completedStates = allStates.filter(
    (s) => s.status !== "running" && !activeRequestIds.has(s.requestId),
  );
  const all = [...activeStates, ...completedStates];
  if (all.length === 0) {
    ctx.ui.notify("No /run jobs in this session.");
    return;
  }
  const board = renderRunsBoard(all, makePlainTheme());
  const width = process.stdout.columns ?? 80;
  const output = board.render(width).join("\n");
  ctx.ui.notify(output);
}
