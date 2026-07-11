/**
 * Model and thinking level resolution for subagent child processes.
 * Handles provider/model selection and thinking level clamping.
 */

import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "../agent/agents.js";

export type ChildModelSettings = {
  provider?: string | undefined;
  id?: string | undefined;
};

/**
 * Minimal live-registry seam consumed by thinking-level resolution.
 * Accepts the public {@link ModelRegistry} from the host extension context
 * or any test double that provides the same lookup contract.
 */
export interface ModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
}

export interface ResolveThinkingLevelOptions {
  registry?: ModelRegistry | undefined;
}

export interface ResolvedThinkingLevel {
  level: ThinkingLevel;
  warning?: string | undefined;
  diagnostic?: string | undefined;
}

const FALLBACK_LEVEL: ThinkingLevel = "off";

function formatProviderModelLabel(
  provider: string | undefined,
  modelId: string | undefined,
): string {
  const providerLabel = provider ?? "unknown";
  const modelLabel = modelId ?? "unknown";
  return `(provider: ${providerLabel}, model: ${modelLabel})`;
}

function formatUnsupportedWarning(
  requested: ThinkingLevel,
  effective: ThinkingLevel,
  provider: string | undefined,
  modelId: string | undefined,
): string {
  return `Thinking level "${requested}" is not supported; using "${effective}" instead ${formatProviderModelLabel(provider, modelId)}`;
}

function formatUnconfirmedWarning(
  requested: ThinkingLevel,
  provider: string | undefined,
  modelId: string | undefined,
): string {
  return `Thinking level "${requested}" support could not be confirmed; requesting as-is ${formatProviderModelLabel(provider, modelId)}`;
}

function resolveModel(
  provider: string,
  modelId: string,
  registry: ModelRegistry | undefined,
): { model: Model<Api> | undefined; diagnostic: string | undefined } {
  if (registry) {
    const live = registry.find(provider, modelId);
    if (live) return { model: live, diagnostic: undefined };
  }
  const diagnostic = registry
    ? undefined
    : "Live model registry unavailable; falling back to static catalog.";
  const staticModel = getModel(provider as never, modelId as never) as
    | Model<Api>
    | undefined;
  return { model: staticModel, diagnostic };
}

function resolveForModel(
  requested: ThinkingLevel,
  provider: string | undefined,
  modelId: string | undefined,
  model: Model<Api>,
): ResolvedThinkingLevel {
  if (model.reasoning === false) {
    return {
      level: FALLBACK_LEVEL,
      warning: formatUnsupportedWarning(
        requested,
        FALLBACK_LEVEL,
        provider,
        modelId,
      ),
    };
  }
  const supported = getSupportedThinkingLevels(model);
  if (supported.length === 0) return { level: requested };
  const clamped = clampThinkingLevel(
    model,
    requested as ModelThinkingLevel,
  ) as ThinkingLevel;
  if (clamped === requested) return { level: requested };
  return {
    level: clamped,
    warning: formatUnsupportedWarning(requested, clamped, provider, modelId),
  };
}

/**
 * Resolves the effective thinking level for a model, preferring the live
 * registry over the static catalog. Confirmed matches (live or static) clamp
 * unsupported levels with the standard unsupported-level warning. Unconfirmed
 * misses—missing provider or model identifiers, missing/unavailable registries,
 * and live or static catalog misses—preserve the requested level for display
 * while warning that support could not be confirmed. Requested `off` always
 * stays warning-free in unconfirmed paths. Registry diagnostics are returned
 * separately and never included in the user-facing warning.
 */
export function resolveThinkingLevel(
  requested: ThinkingLevel,
  provider: string | undefined,
  modelId: string | undefined,
  options?: ResolveThinkingLevelOptions,
): ResolvedThinkingLevel {
  if (!provider || !modelId) {
    if (requested === FALLBACK_LEVEL) return { level: FALLBACK_LEVEL };
    return {
      level: requested,
      warning: formatUnconfirmedWarning(requested, provider, modelId),
    };
  }
  const { model, diagnostic } = resolveModel(
    provider,
    modelId,
    options?.registry,
  );
  if (!model) {
    if (requested === FALLBACK_LEVEL) {
      return diagnostic
        ? { level: FALLBACK_LEVEL, diagnostic }
        : { level: FALLBACK_LEVEL };
    }
    return {
      level: requested,
      warning: formatUnconfirmedWarning(requested, provider, modelId),
      diagnostic,
    };
  }
  const result = resolveForModel(requested, provider, modelId, model);
  return diagnostic ? { ...result, diagnostic } : result;
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
