/**
 * Builds the `pi` command-line arguments and environment for a child
 * subagent process.
 */

import type { AgentConfig, ThinkingLevel } from "../agent/agents.js";
import { subagentDepthEnv } from "../shared/invocation.js";
import { serializeSamplingParams } from "../shared/sampling.js";
import type { ChildModelSettings } from "./model-resolution.js";
import {
  resolveCompleteExtensionPath,
  resolvePackageExtensionPath,
  resolveSamplingExtensionPath,
} from "./process-utils.js";
import { SUBAGENT_RESULT_CONTRACT } from "./prompt-contract.js";

const COMPLETE_EXTENSION_PATH = resolveCompleteExtensionPath();
const SAMPLING_EXTENSION_PATH = resolveSamplingExtensionPath();
const PACKAGE_EXTENSION_PATH = resolvePackageExtensionPath();

export function buildSamplingEnv(agent: AgentConfig): string | undefined {
  return serializeSamplingParams({
    temperature: agent.temperature,
    topP: agent.topP,
  });
}

export interface BuildPiArgsConfig {
  agent: AgentConfig;
  task: string;
  effectiveModel: ChildModelSettings;
  thinking: ThinkingLevel;
  resolvedSkills: { args: string[] };
  tmpPrompt: { filePath: string } | null;
  resolvedExtensionPaths?: string[] | undefined;
  samplingEnv?: string | undefined;
}

export function buildPiArgs(config: BuildPiArgsConfig): string[] {
  const {
    agent,
    task,
    effectiveModel,
    thinking,
    resolvedSkills,
    tmpPrompt,
    resolvedExtensionPaths,
    samplingEnv,
  } = config;
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--approve",
    "--no-themes",
    "--no-prompt-templates",
  ];
  if (agent.extensions !== undefined) {
    args.push("--no-extensions");
  }
  if (effectiveModel.provider && effectiveModel.id)
    args.push("--provider", effectiveModel.provider);
  if (effectiveModel.id) args.push("--model", effectiveModel.id);
  args.push("--thinking", thinking);
  if (agent.tools) {
    const tools = new Set(agent.tools);
    tools.add("complete");
    args.push("--tools", [...tools].join(","));
  }
  if (agent.skills !== undefined)
    args.push("--no-skills", ...resolvedSkills.args);
  if (agent.context === false) args.push("--no-context-files");
  if (tmpPrompt) {
    if (agent.replacePrompt) {
      args.push("--system-prompt", tmpPrompt.filePath);
    } else {
      args.push("--append-system-prompt", tmpPrompt.filePath);
    }
  }
  if (agent.extensions !== undefined) {
    args.push("--extension", PACKAGE_EXTENSION_PATH);
    if (resolvedExtensionPaths && resolvedExtensionPaths.length > 0) {
      for (const rp of resolvedExtensionPaths) {
        if (rp !== PACKAGE_EXTENSION_PATH) {
          args.push("--extension", rp);
        }
      }
    }
  }
  args.push("--extension", COMPLETE_EXTENSION_PATH);
  if (samplingEnv) {
    args.push("--extension", SAMPLING_EXTENSION_PATH);
  }
  args.push("--append-system-prompt", SUBAGENT_RESULT_CONTRACT);
  const taskPrompt = task
    ? `Task: ${task}`
    : "Run according to your system prompt. If no explicit task was provided, use the default context described there.";
  args.push(taskPrompt);
  return args;
}

export function buildChildEnv(
  samplingEnv: string | undefined,
): NodeJS.ProcessEnv {
  const { PI_SAMPLING_PARAMS: _, ...parentEnv } = process.env;
  return {
    ...parentEnv,
    ...subagentDepthEnv(),
    ...(samplingEnv ? { PI_SAMPLING_PARAMS: samplingEnv } : {}),
  };
}
