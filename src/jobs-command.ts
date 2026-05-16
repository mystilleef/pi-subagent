import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { getAllProgressStates, getProgressState } from "./progress-state.js";
import { listRunJobs } from "./run-registry.js";
import { renderRunsBoard } from "./ui.js";

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
  const output = await ctx.ui.custom<string>(
    (_tui, theme, _keybindings, done) => ({
      invalidate() {},
      render(width) {
        const lines = renderRunsBoard(all, theme, width).render(width);
        done(lines.join("\n"));
        return lines;
      },
    }),
  );
  ctx.ui.notify(output);
}
