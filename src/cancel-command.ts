import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cancelAllRunJobs, cancelRunJob, listRunJobs } from "./run-registry.js";

const CANCEL_REASON = "Cancelled by /cancel-subagent";

export async function cancelSubagentCommandHandler(
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const target = args.trim();
  if (!target) {
    const jobs = listRunJobs();
    if (jobs.length === 0) {
      ctx.ui.notify("No active /run jobs.");
      return;
    }
    const options = [
      ...jobs.map(
        (job) => `${job.agentName} ${job.instanceName} (${job.requestId})`,
      ),
      "All running subagents",
    ];
    const selection = await ctx.ui.select("Cancel subagent", options);
    if (selection === undefined) return;
    if (selection === "All running subagents") {
      const count = cancelAllRunJobs(CANCEL_REASON);
      ctx.ui.notify(`Cancelled ${count} /run job${count === 1 ? "" : "s"}.`);
      return;
    }
    const requestId = selection.match(/\((.*)\)$/)?.[1];
    if (requestId) {
      cancelRunJob(requestId, CANCEL_REASON);
      ctx.ui.notify(`Cancelled /run job ${requestId}.`);
    }
    return;
  }
  if (target === "all") {
    const count = cancelAllRunJobs(CANCEL_REASON);
    ctx.ui.notify(
      count === 0
        ? "No active /run jobs."
        : `Cancelled ${count} /run job${count === 1 ? "" : "s"}.`,
    );
    return;
  }
  if (cancelRunJob(target, CANCEL_REASON)) {
    ctx.ui.notify(`Cancelled /run job ${target}.`);
    return;
  }
  ctx.ui.notify(`No active /run job ${target}.`);
}
