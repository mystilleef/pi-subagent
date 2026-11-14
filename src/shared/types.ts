import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "../agent/agents.js";
import type { TerminationMetadata } from "../child/termination.js";

export const TOOL_RESULT_FAILED_MESSAGE = "Subagent tool result failed.";

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

export interface ToolActivity {
  toolName: string;
  inputSummary?: string | undefined;
  instanceName?: string | undefined;
  ordinal?: number | undefined;
  child?: ToolActivity | undefined;
}

export interface StreamingProgressToolCall {
  id: string;
  preview: string;
}

export interface StreamingProgress {
  activityText?: string | undefined;
  activeToolActivity?: ToolActivity | undefined;
  toolCalls: StreamingProgressToolCall[];
  lastToolPreview?: string | undefined;
  toolResultCompleted?: boolean | undefined;
}

export interface SingleResult {
  agent: string;
  instanceName?: string | undefined;
  ordinal?: number | undefined;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  finalOutput: string;
  stderr: string;
  usage: UsageStats;
  model?: string | undefined;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
  durationMs?: number | undefined;
  progress?: StreamingProgress | undefined;
  messages?: Message[] | undefined;
  termination?: TerminationMetadata | undefined;
  thinkingWarning?: string | undefined;
  outcome?: string | undefined;
}

export interface SubagentDetails {
  mode: "single";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  usageTree?: UsageInstanceNode | undefined;
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

export type AccountingStatus = "running" | "success" | "error" | "cancelled";

export interface AdditiveUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface StatusCounts {
  running: number;
  success: number;
  error: number;
  cancelled: number;
}

export interface AgentUsageRollup {
  instances: number;
  statuses: StatusCounts;
  usage: AdditiveUsage;
  durationMs: number;
}

export interface AccountingRollup {
  instances: number;
  statuses: StatusCounts;
  usage: AdditiveUsage;
  durationMs: number;
  byAgent: Record<string, AgentUsageRollup>;
}

export interface OmittedUsage {
  count: number;
  totals: AccountingRollup;
}

export interface UsageInstanceNode {
  id: string;
  agent: string;
  instanceName: string;
  ordinal: number;
  startedAt: number;
  status: AccountingStatus;
  durationMs?: number | undefined;
  usage: AdditiveUsage;
  children: UsageInstanceNode[];
  omitted?: OmittedUsage | undefined;
}

export interface SessionUsageQueryResult {
  rollup: AccountingRollup;
  runs: UsageInstanceNode[];
}

export interface RunUsageQueryResult {
  run: UsageInstanceNode;
  rollup: AccountingRollup;
}

export interface InstanceUsageQueryResult {
  instance: UsageInstanceNode;
  rollup: AccountingRollup;
}
