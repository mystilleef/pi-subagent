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

/** Environment keys stripped from spawned child processes. */
const STRIPPED_CHILD_ENV_KEYS = [
  "PI_SAMPLING_PARAMS",
  "PI_SUBAGENT_WEBHOOK_URL",
] as const;

/**
 * Whether `name` names `key` under the host's environment-name semantics:
 * Windows resolves environment names case-insensitively, so every spelling
 * denotes the same setting, while other hosts treat them as distinct keys.
 */
function namesEnvKey(
  name: string,
  key: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32"
    ? name.toLowerCase() === key.toLowerCase()
    : name === key;
}

/**
 * Builds the spawned Pi child's environment: drops the inherited sampling
 * config and receiver URL token, then applies the child depth marker and the
 * selected agent's sampling override.
 *
 * `parentEnv` supplies the environment to inherit from, letting callers and
 * tests pass a plain snapshot in place of the live `process.env` proxy.
 */
export function buildChildEnv(
  samplingEnv: string | undefined,
  platform: NodeJS.Platform = process.platform,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const filteredEnv = Object.fromEntries(
    Object.entries(parentEnv).filter(
      ([name]) =>
        !STRIPPED_CHILD_ENV_KEYS.some((key) =>
          namesEnvKey(name, key, platform),
        ),
    ),
  );
  return {
    ...filteredEnv,
    ...subagentDepthEnv(),
    ...(samplingEnv ? { PI_SAMPLING_PARAMS: samplingEnv } : {}),
  };
}
