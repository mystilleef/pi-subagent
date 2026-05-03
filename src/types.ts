import type { Message } from "@mariozechner/pi-ai";
import type { AgentScope } from "./agents.js";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface SubagentDetails {
  mode: "single";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

export type OnUpdateCallback = (partial: {
  content: { type: "text"; text: string }[];
  details: SubagentDetails;
}) => void;
