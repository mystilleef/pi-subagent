import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  getAllProgressStates,
  type SubagentProgressState,
} from "./progress-state.js";
import { listRunJobs } from "./run-registry.js";
import { renderRunsBoard } from "./ui.js";

export async function jobsCommandHandler(
  ctx: ExtensionCommandContext,
  _args: string,
): Promise<void> {
  const activeRequestIds = new Set(listRunJobs().map((j) => j.requestId));
  const active: SubagentProgressState[] = [];
  const completed: SubagentProgressState[] = [];
  for (const s of getAllProgressStates()) {
    if (activeRequestIds.has(s.requestId)) active.push(s);
    else if (s.status !== "running") completed.push(s);
  }
  const all = [...active, ...completed];
  if (all.length === 0) {
    ctx.ui.notify("No /run jobs in this session.");
    return;
  }
  const output = await ctx.ui.custom<string>(
    (_tui, theme, _keybindings, done) => ({
      invalidate() {},
      render(width) {
        const tuiLines = renderRunsBoard(all, theme, width).render(width);
        const notifyWidth = Math.max(1, width - 2);
        const notifyLines = renderRunsBoard(all, theme, notifyWidth).render(
          notifyWidth,
        );
        done(notifyLines.join("\n"));
        return tuiLines;
      },
    }),
  );
  ctx.ui.notify(output);
}
