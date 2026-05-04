import { StringEnum } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  type AgentConfig,
  type AgentScope,
  discoverAgents,
  type ThinkingLevel,
} from "./agents.js";
import { runSingleAgent } from "./process.js";
import type { SingleResult, SubagentDetails } from "./types.js";
import { renderSubagentCall, renderSubagentResult } from "./ui.js";
import { detectMessageError, trimForLLM } from "./utils.js";

const agentCache = new Map<string, { agents: AgentConfig[]; ts: number }>();
export function resetAgentCache() {
  agentCache.clear();
}

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

async function executeSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: Static<typeof SubagentParams>,
  signal: AbortSignal,
  onUpdate?: (result: {
    content: { type: "text"; text: string }[];
    details: SubagentDetails;
  }) => void,
): Promise<{
  content: { type: "text"; text: string }[];
  details: SubagentDetails;
}> {
  const agentScope: AgentScope = params.agentScope ?? "both";
  const discovery = discoverAgents(ctx.cwd, agentScope);
  const agents = discovery.agents;
  const parentModel = ctx.model
    ? { provider: ctx.model.provider, id: ctx.model.id }
    : undefined;
  const parentThinking = pi.getThinkingLevel() as ThinkingLevel;
  const includeDebugMessages = params.debug === true;
  const makeDetails = (
    results: SingleResult[],
    options?: { includeMessages?: boolean },
  ): SubagentDetails => ({
    mode: "single",
    agentScope,
    projectAgentsDir: discovery.projectAgentsDir,
    results: results.map((result) => {
      const { messages, ...rest } = result;
      const base = { ...rest, usage: { ...result.usage } };
      if (includeDebugMessages || options?.includeMessages) {
        return { ...base, messages: messages ? [...messages] : undefined };
      }
      return base;
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
              type: "text" as const,
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
        type: "text" as const,
        text: trimForLLM(result.finalOutput) || "(no output)",
      },
    ],
    details: makeDetails([result]),
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("run", {
    description: "Run a subagent directly: /run <agent> [task]",
    getArgumentCompletions: async (prefix: string) => {
      const cwd = process.cwd();
      const now = Date.now();
      let entry = agentCache.get(cwd);
      if (!entry || now - entry.ts > 1_000) {
        entry = { agents: discoverAgents(cwd, "both").agents, ts: now };
        agentCache.set(cwd, entry);
      }
      return entry.agents
        .filter((a) => a.name.startsWith(prefix))
        .map((a) => ({ value: a.name, label: a.name }));
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify("Usage: /run <agent> [task]", "error");
        return;
      }
      const firstSpace = input.indexOf(" ");
      const agentName = firstSpace === -1 ? input : input.slice(0, firstSpace);
      const task = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
      const discovery = discoverAgents(ctx.cwd, "both");
      if (!discovery.agents.find((a) => a.name === agentName)) {
        ctx.ui.notify(`Unknown agent: ${agentName}`, "error");
        return;
      }
      try {
        const result = await executeSubagent(
          pi,
          ctx,
          { agent: agentName, task },
          new AbortController().signal,
        );
        pi.sendMessage({
          customType: "text",
          content: result.content[0]?.text || "(no output)",
          display: true,
        });
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: ["Delegate a task to a subagent with isolated context."].join(
      " ",
    ),
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeSubagent(
        pi,
        ctx,
        params,
        signal ?? new AbortController().signal,
        onUpdate,
      );
    },
    renderCall(args, theme, _context) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, display, theme, _context) {
      return renderSubagentResult(result, theme, display);
    },
  });
}
