import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cancelAllRunJobs, cancelRunJob, listRunJobs } from "./run-registry.js";

const CANCEL_REASON = "Cancelled by /cancel-subagent";

export function cancelSubagentCommandHandler(
  ctx: ExtensionCommandContext,
  args: string,
): void {
  const target = args.trim();
  if (!target) {
    const jobs = listRunJobs();
    if (jobs.length === 0) {
      ctx.ui.notify("No active /run jobs.");
      return;
    }
    ctx.ui.notify(
      `Active /run jobs: ${jobs.map((job) => job.requestId).join(", ")}`,
    );
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
