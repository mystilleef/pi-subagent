import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseSamplingParams,
  type SamplingParams,
} from "../shared/sampling.js";

function applySamplingParams(
  target: Record<string, unknown>,
  params: SamplingParams,
  topPKey: "topP" | "top_p",
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  if (params.temperature !== undefined)
    result["temperature"] = params.temperature;
  if (params.topP !== undefined) result[topPKey] = params.topP;
  return result;
}

export function patchPayload(
  payload: Record<string, unknown>,
  params: SamplingParams,
): Record<string, unknown> {
  if ("generationConfig" in payload) {
    const origConfig =
      payload["generationConfig"] &&
      typeof payload["generationConfig"] === "object"
        ? (payload["generationConfig"] as Record<string, unknown>)
        : {};
    return {
      ...payload,
      generationConfig: applySamplingParams(origConfig, params, "topP"),
    };
  }
  return applySamplingParams(payload, params, "top_p");
}

export default function (pi: ExtensionAPI) {
  const params = parseSamplingParams(process.env["PI_SAMPLING_PARAMS"]);
  if (!params) return;
  pi.on("before_provider_request", (event) => {
    if (
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    )
      return;
    return patchPayload(event.payload as Record<string, unknown>, params);
  });
}
