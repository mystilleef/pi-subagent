import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "../agent/agents.js";
import type { TerminationMetadata } from "../child/termination.js";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  contextWindowTokens?: number;
  turns: number;
}

export interface ActivityFrame {
  preview: string;
  instanceName?: string;
}

export interface StreamingProgressToolCall {
  id: string;
  preview: string;
}

export interface StreamingProgress {
  activityText?: string;
  activityStack?: ActivityFrame[];
  toolCalls: StreamingProgressToolCall[];
  lastToolPreview?: string;
  toolResultCompleted?: boolean;
}

export interface SingleResult {
  agent: string;
  instanceName?: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  finalOutput: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  durationMs?: number;
  progress?: StreamingProgress;
  messages?: Message[];
  termination?: TerminationMetadata;
  thinkingWarning?: string;
}

export interface SubagentDetails {
  mode: "single";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  renderedByMessage?: true;
}

export interface SubagentToolResult {
  content: { type: "text"; text: string }[];
  details: SubagentDetails;
}

export type OnUpdateCallback = (partial: {
  content: { type: "text"; text: string }[];
  details: SubagentDetails;
}) => void;
