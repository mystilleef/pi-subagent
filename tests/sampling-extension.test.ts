import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSamplingExtension, {
  patchPayload,
} from "../src/child/sampling-extension.js";
import type { SamplingParams } from "../src/shared/sampling.js";
import { withEnv } from "./fixtures.js";

type ProviderRequestHandler = (event: { payload: unknown }) => unknown;

/**
 * Registers the extension under the given `PI_SAMPLING_PARAMS` and returns its
 * `before_provider_request` handler; the extension reads the env only at
 * registration, so the handler runs after the env is restored.
 */
function registerWithSamplingEnv(
  params: string | undefined,
): ProviderRequestHandler | undefined {
  let handler: ProviderRequestHandler | undefined;
  const pi = {
    on(event: string, registered: ProviderRequestHandler) {
      if (event === "before_provider_request") handler = registered;
    },
  } as unknown as ExtensionAPI;
  withEnv({ PI_SAMPLING_PARAMS: params }, () => registerSamplingExtension(pi));
  return handler;
}

describe("patchPayload", () => {
  test("patches flat payloads without mutating original", () => {
    const payload = Object.freeze({ model: "claude-3-5", messages: [] });
    const patched = patchPayload(payload, { temperature: 0.2, topP: 0.9 });
    expect(patched).toEqual({
      model: "claude-3-5",
      messages: [],
      temperature: 0.2,
      top_p: 0.9,
    });
    expect(patched).not.toBe(payload);
  });

  test("patches generationConfig payloads without mutating original", () => {
    const innerConfig = Object.freeze({ maxOutputTokens: 100 });
    const payload = Object.freeze({
      model: "gemini",
      generationConfig: innerConfig,
    });
    const patched = patchPayload(payload, { temperature: 0.4, topP: 0.7 });
    expect(patched).toEqual({
      model: "gemini",
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.4,
        topP: 0.7,
      },
    });
    expect(patched).not.toBe(payload);
    expect(patched["generationConfig"]).not.toBe(innerConfig);
  });

  test.each<{
    name: string;
    payload: Record<string, unknown>;
    params: SamplingParams;
    expected: Record<string, unknown>;
  }>([
    {
      name: "patches flat payload with temperature only",
      payload: { model: "gpt-4", prompt: "hi" },
      params: { temperature: 0.5 },
      expected: { model: "gpt-4", prompt: "hi", temperature: 0.5 },
    },
    {
      name: "patches flat payload with topP only",
      payload: { model: "gpt-4", prompt: "hi" },
      params: { topP: 0.3 },
      expected: { model: "gpt-4", prompt: "hi", top_p: 0.3 },
    },
    {
      name: "patches generationConfig payload with single field",
      payload: { model: "gemini", generationConfig: { topP: 0.1 } },
      params: { temperature: 0.9 },
      expected: {
        model: "gemini",
        generationConfig: { topP: 0.1, temperature: 0.9 },
      },
    },
    {
      name: "overwrites existing sampling keys in flat payload",
      payload: { model: "gpt-4", temperature: 0.9, top_p: 0.2 },
      params: { temperature: 0.5, topP: 0.8 },
      expected: { model: "gpt-4", temperature: 0.5, top_p: 0.8 },
    },
    {
      name: "treats non-object generationConfig as empty object",
      payload: { model: "gemini", generationConfig: null },
      params: { temperature: 0.3, topP: 0.6 },
      expected: {
        model: "gemini",
        generationConfig: { temperature: 0.3, topP: 0.6 },
      },
    },
  ])("$name", ({ payload, params, expected }) => {
    expect(patchPayload(payload, params)).toEqual(expected);
  });
});

describe("sampling extension hook", () => {
  test("registers before_provider_request and patches when PI_SAMPLING_PARAMS is set", () => {
    const handler = registerWithSamplingEnv(
      JSON.stringify({ temperature: 0.1 }),
    );
    expect(handler?.({ payload: { model: "claude-3", messages: [] } })).toEqual(
      { model: "claude-3", messages: [], temperature: 0.1 },
    );
  });

  test.each([
    { condition: "is not set", params: undefined },
    { condition: "contains invalid JSON", params: "{invalid}" },
  ])(
    "does not register handler when PI_SAMPLING_PARAMS $condition",
    ({ params }) => {
      expect(registerWithSamplingEnv(params)).toBeUndefined();
    },
  );

  test("does not mutate original payload in hook execution", () => {
    const handler = registerWithSamplingEnv(
      JSON.stringify({ temperature: 0.1 }),
    );
    const payload = Object.freeze({
      model: "claude-3",
      messages: Object.freeze([]),
    });
    const patched = handler?.({ payload });
    expect(patched).toEqual({
      model: "claude-3",
      messages: [],
      temperature: 0.1,
    });
    expect(patched).not.toBe(payload);
  });

  test.each([
    { label: "null", payload: null },
    { label: "a string", payload: "string" },
    { label: "an array", payload: [] },
  ])("returns undefined for $label payload", ({ payload }) => {
    const handler = registerWithSamplingEnv(
      JSON.stringify({ temperature: 0.1 }),
    );
    if (!handler) throw new Error("handler not registered");
    expect(handler({ payload })).toBeUndefined();
  });
});
