import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  renderStatsBoard,
  renderStatsRunBoard,
} from "../output/stats-board.js";
import { notifyBoard } from "../output/ui.js";
import { queryRootRunUsage, querySessionUsage } from "./usage-ledger.js";

export async function statsCommandHandler(
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const target = args.trim();
  if (!target) {
    const { runs, rollup } = querySessionUsage();
    if (runs.length === 0) {
      ctx.ui.notify("No subagent runs in this session.");
      return;
    }
    await notifyBoard(ctx, (theme, width) =>
      renderStatsBoard(runs, rollup, theme, width),
    );
    return;
  }
  const match = queryRootRunUsage(target);
  if (!match) {
    ctx.ui.notify(`No run matches "${target}".`);
    return;
  }
  await notifyBoard(ctx, (theme) =>
    renderStatsRunBoard(match.run, match.rollup, theme),
  );
}
