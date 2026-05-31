import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getCachedAgentCompletions,
  resetAgentDiscoveryCache,
} from "./agent/agent-cache.js";
import { cancelSubagentCommandHandler } from "./orchestration/cancel-command.js";
import { jobsCommandHandler } from "./orchestration/jobs-command.js";
import { renderSubagentResultMessage } from "./orchestration/run.js";
import { runCommandHandler } from "./orchestration/run-command.js";
import {
  formatSubagentToolResult,
  SubagentParams,
  startSubagentJob,
} from "./orchestration/subagent-orchestrator.js";
import { renderSubagentCall, renderSubagentToolResult } from "./output/ui.js";
import { renderSubagentProgress } from "./progress/progress.js";

export { SubagentParams };

export function resetAgentCache() {
  resetAgentDiscoveryCache();
}

export default function registerSubagentExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent-progress", renderSubagentProgress);
  pi.registerMessageRenderer("subagent-result", renderSubagentResultMessage);
  pi.registerCommand("run", {
    description: "Run a subagent directly: /run <agent> [task]",
    getArgumentCompletions: (prefix: string) =>
      getCachedAgentCompletions(prefix),
    handler: async (args, ctx) =>
      runCommandHandler(pi, ctx as ExtensionContext, args),
  });
  pi.registerCommand("cancel-subagent", {
    description:
      "Cancel active /run subagents: /cancel-subagent [requestId|all]",
    handler: async (args, ctx) => cancelSubagentCommandHandler(ctx, args),
  });
  pi.registerCommand("jobs", {
    description: "List all /run jobs and their statuses: /jobs",
    handler: async (args, ctx) => jobsCommandHandler(ctx, args),
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a subagent with isolated context.",
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await startSubagentJob(
        pi,
        ctx,
        params,
        signal ?? undefined,
      );
      return formatSubagentToolResult(params.agent, result);
    },
    renderCall(args, theme, _context) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, display, theme, _context) {
      return renderSubagentToolResult(result, theme, display);
    },
  });
}
