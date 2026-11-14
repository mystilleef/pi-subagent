import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyBoard, renderRunsBoard } from "../output/ui.js";
import {
  getAllProgressStates,
  type SubagentProgressState,
} from "../progress/progress-state.js";
import type { UsageInstanceNode } from "../shared/types.js";
import { listRunJobs } from "./run-registry.js";
import { queryInstanceUsage, querySessionUsage } from "./usage-ledger.js";

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
  const instances = new Map<string, UsageInstanceNode>();
  for (const { requestId } of all) {
    const held = queryInstanceUsage(requestId);
    if (held) instances.set(requestId, held.instance);
  }
  const usage = { session: querySessionUsage(), instances };
  await notifyBoard(ctx, (theme, width) =>
    renderRunsBoard(all, theme, width, usage),
  );
}
