import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../agent/agents.js";
import { getFinalOutput } from "../output/ui.js";
import {
  type SingleResult,
  TOOL_RESULT_FAILED_MESSAGE,
} from "../shared/types.js";
import { truncateOutput } from "../shared/utils.js";
import { resolveContextWindowTokens } from "./process-utils.js";

export type RuntimeResult = SingleResult & { messages: Message[] };

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

export function initRuntimeResult(
  agentName: string,
  source: "user" | "project" | "unknown",
  task: string,
  modelDisplay: string | undefined,
): RuntimeResult {
  return {
    agent: agentName,
    agentSource: source,
    task,
    exitCode: 0,
    finalOutput: "",
    messages: [],
    stderr: "",
    usage: { ...EMPTY_USAGE },
    model: modelDisplay,
  };
}

function accumulateUsage(result: RuntimeResult, msg: Message): void {
  if (msg.role !== "assistant") return;
  result.usage.turns++;
  const { usage } = msg;
  if (!usage) return;
  result.usage.input += usage.input || 0;
  result.usage.output += usage.output || 0;
  result.usage.cacheRead += usage.cacheRead || 0;
  result.usage.cacheWrite += usage.cacheWrite || 0;
  result.usage.cost += usage.cost?.total || 0;
  result.usage.contextTokens = usage.totalTokens || 0;
  const ctxWindowTokens = resolveContextWindowTokens(msg);
  if (ctxWindowTokens !== undefined)
    result.usage.contextWindowTokens = ctxWindowTokens;
}

export function addMessageToResult(result: RuntimeResult, msg: Message): void {
  result.messages.push(msg);
  result.finalOutput = truncateOutput(getFinalOutput(result.messages));
  if (msg.role === "toolResult" && msg.isError) {
    result.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
  } else if (result.errorMessage === TOOL_RESULT_FAILED_MESSAGE) {
    delete result.errorMessage;
  }
  if (msg.role === "assistant") {
    accumulateUsage(result, msg);
    if (!result.model && msg.model) result.model = msg.model;
    if (msg.stopReason) result.stopReason = msg.stopReason;
    if (msg.errorMessage) result.errorMessage = msg.errorMessage;
  }
}

export function rebuildResultFromMessages(
  result: RuntimeResult,
  messages: Message[],
): void {
  const { model } = result;
  result.messages = [];
  result.finalOutput = "";
  result.usage = { ...EMPTY_USAGE };
  result.model = model;
  delete result.errorMessage;
  delete result.stopReason;
  for (const msg of messages) {
    addMessageToResult(result, msg);
  }
}

export function createErrorResult(
  agent: string,
  source: "user" | "project" | "unknown",
  task: string,
  error: string,
  model?: string,
): SingleResult {
  return {
    agent,
    agentSource: source,
    task,
    exitCode: 1,
    finalOutput: "",
    stderr: error,
    usage: { ...EMPTY_USAGE },
    model,
  };
}

export function errorForUnknownAgent(
  agentName: string,
  agents: AgentConfig[],
  task: string,
): SingleResult {
  const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
  return createErrorResult(
    agentName,
    "unknown",
    task,
    `Unknown agent: "${agentName}". Available agents: ${available}.`,
  );
}

export function errorForDepthLimit(
  agentName: string,
  source: "user" | "project" | "unknown",
  task: string,
  depth: number,
  maxDepth: number,
  model?: string,
): SingleResult {
  return createErrorResult(
    agentName,
    source,
    task,
    `Subagent nesting limit reached (depth ${depth}/${maxDepth}).`,
    model,
  );
}
