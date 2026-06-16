/**
 * Model and thinking level resolution for subagent child processes.
 * Handles provider/model selection and thinking level clamping.
 */

import {
  clampThinkingLevel,
  getModel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../agent/agents.js";

export type ChildModelSettings = {
  provider?: string | undefined;
  id?: string | undefined;
};

/**
 * Resolves the effective thinking level for a model, clamping to supported levels.
 * Returns a warning message if the requested level differs from the effective level.
 */
export function resolveThinkingLevel(
  requested: ThinkingLevel,
  provider: string,
  modelId: string,
): { level: ThinkingLevel; warning?: string } {
  const model = getModel(provider as never, modelId as never);
  if (!model) return { level: requested };
  const mkWarning = (effective: ThinkingLevel) =>
    `Thinking level "${requested}" not supported by model "${provider}/${modelId}"; using "${effective}" instead`;
  if (model.reasoning === false) {
    return { level: "off", warning: mkWarning("off") };
  }
  if (!model.thinkingLevelMap) return { level: requested };
  const supported = getSupportedThinkingLevels(model);
  if (supported.length === 0) return { level: requested };
  const clamped = clampThinkingLevel(
    model,
    requested as ModelThinkingLevel,
  ) as ThinkingLevel;
  if (clamped === requested) return { level: requested };
  return { level: clamped, warning: mkWarning(clamped) };
}

/**
 * Resolves effective child model settings by merging agent config with parent settings.
 * Agent-specific settings take precedence over parent settings.
 */
export function resolveEffectiveChildModelSettings(
  agent: { provider?: string | undefined; model?: string | undefined },
  parentModel: ChildModelSettings | undefined,
): ChildModelSettings {
  return {
    provider: agent.provider ?? parentModel?.provider,
    id:
      agent.model ??
      (agent.provider === undefined ? parentModel?.id : undefined),
  };
}

/**
 * Builds a display string for the model and thinking level.
 * Returns undefined if no parts are available.
 */
export function buildModelDisplay(
  effectiveModel: ChildModelSettings,
  thinking: ThinkingLevel,
): string | undefined {
  const parts: string[] = [];
  if (effectiveModel.provider) {
    parts.push(effectiveModel.provider);
  }
  if (effectiveModel.id) {
    parts.push(effectiveModel.id);
  }
  if (thinking) {
    parts.push(thinking);
  }
  return parts.length > 0 ? parts.join(" ･ ") : undefined;
}
