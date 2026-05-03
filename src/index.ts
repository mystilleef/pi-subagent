/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports a single mode: { agent: "name", task: "..." }.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  type AgentScope,
  discoverAgents,
  type ThinkingLevel,
} from "./agents.js";
import { runSingleAgent } from "./process.js";
import type { SingleResult, SubagentDetails } from "./types.js";
import { renderSubagentCall, renderSubagentResult } from "./ui.js";
import { detectMessageError, truncateOutput } from "./utils.js";

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "both" (user + project-local agents).',
  default: "both",
});

export const SubagentParams = Type.Object({
  agent: Type.String({
    description: "Name of the agent to invoke",
  }),
  task: Type.String({ description: "Task to delegate" }),
  agentScope: Type.Optional(AgentScopeSchema),
  debug: Type.Optional(
    Type.Boolean({
      description:
        "Internal debug option. Include full child messages in result details.",
      default: false,
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);

        // Match `/run ` followed by an incomplete agent name (no spaces)
        const match = beforeCursor.match(/(?:^|[ \t])\/run\s+([^\s]*)$/);
        if (!match) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const prefix = match[1] ?? "";
        // Default to "both" scopes for completion
        const agents = discoverAgents(ctx.cwd, "both").agents;

        return {
          prefix,
          items: agents
            .filter((a) => a.name.startsWith(prefix))
            .map((a) => ({ value: a.name, label: a.name })),
        };
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        );
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return (
          current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
          true
        );
      },
    }));
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate one task to one specialized subagent with isolated context.",
      "Mode: single (agent + task).",
      'Default agent scope is "both" (user agents from ~/.pi/agents and project-local agents from .pi/agents).',
      "Output returns with configurable truncation via PI_SUBAGENT_MAX_OUTPUT_BYTES and PI_SUBAGENT_MAX_OUTPUT_LINES.",
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "both";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const parentModel = ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined;
      const parentThinking = pi.getThinkingLevel() as ThinkingLevel;

      const includeDebugMessages = params.debug === true;
      const makeDetails = (results: SingleResult[]): SubagentDetails => ({
        mode: "single",
        agentScope,
        projectAgentsDir: discovery.projectAgentsDir,
        results: results.map((result) => {
          if (includeDebugMessages) return result;
          const { messages: _messages, ...compact } = result;
          return compact;
        }),
      });

      if ((agentScope === "project" || agentScope === "both") && ctx.hasUI) {
        const requested = agents.find((a) => a.name === params.agent);
        if (requested?.source === "project") {
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agent?",
            `Agent: ${requested.name}
Source: ${dir}

Project agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok)
            return {
              content: [
                {
                  type: "text",
                  text: "Canceled: project-local agent not approved.",
                },
              ],
              details: makeDetails([]),
            };
        }
      }

      const result = await runSingleAgent(
        ctx.cwd,
        agents,
        params.agent,
        params.task,
        signal,
        onUpdate,
        makeDetails,
        parentModel,
        parentThinking,
      );
      const failed =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted" ||
        detectMessageError(result.messages ?? []);
      if (failed) {
        const errorMsg =
          result.errorMessage ||
          result.stderr ||
          result.finalOutput ||
          "(no output)";
        throw new Error(`Agent ${result.stopReason || "failed"}: ${errorMsg}`);
      }
      return {
        content: [
          {
            type: "text",
            text: truncateOutput(result.finalOutput) || "(no output)",
          },
        ],
        details: makeDetails([result]),
      };
    },

    renderCall(args, theme, _context) {
      return renderSubagentCall(args, theme);
    },

    renderResult(result, _display, theme, _context) {
      return renderSubagentResult(result, theme);
    },
  });
}
