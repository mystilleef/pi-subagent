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
  test("returns undefined for missing or empty input", () => {
    expect(parseSamplingParams()).toBeUndefined();
    expect(parseSamplingParams("")).toBeUndefined();
  });

  test.each([
    { name: "returns undefined for malformed JSON", params: "{not json}" },
    { name: "returns undefined for empty object input", params: "{}" },
  ])("$name", (row) => {
    expect(parseSamplingParams(row.params)).toBeUndefined();
  });

  test("returns undefined for non-object JSON", () => {
    expect(parseSamplingParams("42")).toBeUndefined();
    expect(parseSamplingParams('"string"')).toBeUndefined();
    expect(parseSamplingParams("[]")).toBeUndefined();
    expect(parseSamplingParams("null")).toBeUndefined();
  });

  test("parses valid temperature and topP", () => {
    expect(parseSamplingParams('{"temperature":0.5,"topP":0.8}')).toEqual({
      temperature: 0.5,
      topP: 0.8,
    });
  });

  test("drops unsupported keys and invalid values", () => {
    expect(
      parseSamplingParams('{"temperature":0.5,"topP":2,"extra":true}'),
    ).toEqual({ temperature: 0.5 });
  });

  test("returns undefined when all values are invalid", () => {
    expect(
      parseSamplingParams('{"temperature":-1,"topP":1.5}'),
    ).toBeUndefined();
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
