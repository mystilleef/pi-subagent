export interface SamplingParams {
  temperature?: number | undefined;
  topP?: number | undefined;
}

export function isValidSamplingValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0.0 &&
    value <= 1.0
  );
}

/**
 * Parses a JSON-encoded sampling parameters string.
 * Returns undefined for missing, malformed, or wholly invalid values.
 */
export function parseSamplingParams(
  envVal?: string,
): SamplingParams | undefined {
  if (!envVal) return undefined;
  try {
    const parsed = JSON.parse(envVal);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const { temperature: rawTemperature, topP: rawTopP } = parsed as Record<
      string,
      unknown
    >;
    const result: SamplingParams = {};
    if (isValidSamplingValue(rawTemperature))
      result.temperature = rawTemperature;
    if (isValidSamplingValue(rawTopP)) result.topP = rawTopP;
    if (result.temperature !== undefined || result.topP !== undefined)
      return result;
  } catch {
    /* malformed env value: run without sampling overrides */
  }
  return undefined;
}

/**
 * Serializes sampling parameters into a JSON string for environment passing.
 * Returns undefined when no valid parameters are present.
 */
export function serializeSamplingParams(
  params: SamplingParams,
): string | undefined {
  if (params.temperature === undefined && params.topP === undefined)
    return undefined;
  const config: SamplingParams = {};
  if (params.temperature !== undefined) config.temperature = params.temperature;
  if (params.topP !== undefined) config.topP = params.topP;
  return JSON.stringify(config);
}
