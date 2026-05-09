import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { cancelSubagentCommandHandler } from "./cancel-command.js";
import { renderSubagentProgress } from "./progress.js";
import {
  getCachedAgentCompletions,
  renderSubagentResultMessage,
  resetAgentDiscoveryCache,
  runCommandHandler,
  SubagentParams,
  startSubagentJob,
} from "./run.js";
import { renderSubagentCall, renderSubagentResult } from "./ui.js";

export { SubagentParams };

export function resetAgentCache() {
  resetAgentDiscoveryCache();
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent-progress", (message, options, theme) =>
    renderSubagentProgress(message, options, theme),
  );
  pi.registerMessageRenderer("subagent-result", (message, _options, theme) =>
    renderSubagentResultMessage(message, theme),
  );
  pi.registerCommand("run", {
    description: "Run a subagent directly: /run <agent> [task]",
    getArgumentCompletions: async (prefix: string) =>
      getCachedAgentCompletions(prefix),
    handler: async (args, ctx) =>
      runCommandHandler(pi, ctx as ExtensionContext, args),
  });
  pi.registerCommand("cancel-subagent", {
    description:
      "Cancel active /run subagents: /cancel-subagent [requestId|all]",
    handler: async (args, ctx) => cancelSubagentCommandHandler(ctx, args),
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
      if (result.kind === "not_found") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown agent: "${params.agent}"`,
            },
          ],
          details: result.makeDetails([]),
        };
      }
      if (result.kind === "cancelled") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Canceled: project-local agent not approved.",
            },
          ],
          details: result.makeDetails([]),
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Subagent ${params.agent} started (job: ${result.requestId}).`,
          },
        ],
        details: result.makeDetails([]),
      };
    },
    renderCall(args, theme, _context) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, display, theme, _context) {
      return renderSubagentResult(result, theme, display);
    },
  });
}
