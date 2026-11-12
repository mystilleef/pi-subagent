import { describe, expect, test } from "bun:test";
import {
  isValidSamplingValue,
  parseSamplingParams,
  serializeSamplingParams,
} from "../src/shared/sampling.js";

describe("isValidSamplingValue", () => {
  test("accepts finite numbers in the closed unit interval", () => {
    expect(isValidSamplingValue(0)).toBe(true);
    expect(isValidSamplingValue(1)).toBe(true);
    expect(isValidSamplingValue(0.5)).toBe(true);
  });

  test("rejects values outside the unit interval", () => {
    expect(isValidSamplingValue(-0.001)).toBe(false);
    expect(isValidSamplingValue(1.001)).toBe(false);
  });

  test("rejects non-finite numbers", () => {
    expect(isValidSamplingValue(Number.NaN)).toBe(false);
    expect(isValidSamplingValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidSamplingValue(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  test("rejects non-number values", () => {
    expect(isValidSamplingValue("0.5")).toBe(false);
    expect(isValidSamplingValue(null)).toBe(false);
    expect(isValidSamplingValue(undefined)).toBe(false);
    expect(isValidSamplingValue({})).toBe(false);
  });
});

describe("parseSamplingParams", () => {
  test.each([
    {
      name: "parses valid full sampling parameters",
      params: '{"temperature":0.5,"topP":0.8}',
      expectedTemperature: 0.5,
      expectedTopP: 0.8,
    },
    {
      name: "accepts boundary values 0 and 1",
      params: '{"temperature":0,"topP":1}',
      expectedTemperature: 0,
      expectedTopP: 1,
    },
  ])("$name", (row) => {
    const res = parseSamplingParams(row.params);
    expect(res).toEqual({
      temperature: row.expectedTemperature,
      topP: row.expectedTopP,
    });
  });

  test.each([
    {
      name: "parses valid single temperature parameter",
      params: '{"temperature":0.7}',
      expectedTemperature: 0.7,
    },
    {
      name: "ignores unsupported keys",
      params: '{"temperature":0.5,"unsupported":123}',
      expectedTemperature: 0.5,
    },
  ])("$name", (row) => {
    const res = parseSamplingParams(row.params);
    expect(res).toEqual({ temperature: row.expectedTemperature });
  });

  test("parses valid single topP parameter", () => {
    const res = parseSamplingParams('{"topP":0.1}');
    expect(res).toEqual({ topP: 0.1 });
  });

  test("returns undefined for missing or empty env val", () => {
    expect(parseSamplingParams()).toBeUndefined();
    expect(parseSamplingParams("")).toBeUndefined();
  });

  test("returns undefined for malformed JSON", () => {
    expect(parseSamplingParams("{invalid}")).toBeUndefined();
  });

  test.each([
    {
      name: "returns undefined for non-object JSON",
      params1: "42",
      params2: '"string"',
      params3: "[]",
    },
    {
      name: "ignores invalid topP values",
      params1: '{"topP":1.1}',
      params2: '{"topP":-0.01}',
      params3: '{"topP":null}',
    },
    {
      name: "returns undefined for unsupported-only and invalid-only inputs",
      params1: '{"unsupported":123}',
      params2: '{"temperature":-1}',
      params3: '{"topP":2}',
    },
  ])("$name", (row) => {
    expect(parseSamplingParams(row.params1)).toBeUndefined();
    expect(parseSamplingParams(row.params2)).toBeUndefined();
    expect(parseSamplingParams(row.params3)).toBeUndefined();
  });

  test("ignores invalid temperature values", () => {
    expect(parseSamplingParams('{"temperature":1.5}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":-0.1}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":"0.5"}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":NaN}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":Infinity}')).toBeUndefined();
  });

  test("accepts valid value when other value is invalid in both directions", () => {
    const res1 = parseSamplingParams('{"temperature":0.5,"topP":1.5}');
    expect(res1).toEqual({ temperature: 0.5 });
    const res2 = parseSamplingParams('{"temperature":-0.5,"topP":0.8}');
    expect(res2).toEqual({ topP: 0.8 });
  });
});

describe("serializeSamplingParams", () => {
  test("returns undefined when both fields are absent", () => {
    expect(serializeSamplingParams({})).toBeUndefined();
  });

  test("serializes temperature only", () => {
    expect(serializeSamplingParams({ temperature: 0.5 })).toBe(
      '{"temperature":0.5}',
    );
  });

  test("serializes topP only", () => {
    expect(serializeSamplingParams({ topP: 0.8 })).toBe('{"topP":0.8}');
  });

  test.each([
    {
      name: "serializes both fields",
      temperature: 0.5,
      topP: 0.8,
      expected: '{"temperature":0.5,"topP":0.8}',
    },
    {
      name: "serializes boundary zero values",
      temperature: 0,
      topP: 0,
      expected: '{"temperature":0,"topP":0}',
    },
  ])("$name", (row) => {
    expect(
      serializeSamplingParams({ temperature: row.temperature, topP: row.topP }),
    ).toBe(row.expected);
  });
});
