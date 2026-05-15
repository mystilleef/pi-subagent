import { afterEach, describe, expect, test } from "bun:test";
import {
  configureSubagentInstanceNamesForTest,
  generateSubagentInstanceName,
  resetSubagentInstanceNamesForTest,
} from "../src/instance-name.js";

afterEach(() => {
  resetSubagentInstanceNamesForTest();
});

describe("generateSubagentInstanceName", () => {
  test("generates lower-case kebab adjective-noun names", () => {
    const name = generateSubagentInstanceName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });
  test("normalizes invalid random values to a valid first name", () => {
    configureSubagentInstanceNamesForTest({
      adjectives: ["able"],
      nouns: ["falcon"],
      randomSource: () => Number.NaN,
    });
    expect(generateSubagentInstanceName()).toBe("able-falcon");
  });
  test("clamps random values outside the valid range", () => {
    configureSubagentInstanceNamesForTest({
      adjectives: ["able", "brave"],
      nouns: ["falcon", "otter"],
      randomSource: () => -0.5,
    });
    expect(generateSubagentInstanceName()).toBe("able-falcon");
    configureSubagentInstanceNamesForTest({
      adjectives: ["able", "brave"],
      nouns: ["falcon", "otter"],
      randomSource: () => 2,
    });
    expect(generateSubagentInstanceName()).toBe("brave-otter");
  });
  test("prevents duplicates within the parent session", () => {
    const names = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      names.add(generateSubagentInstanceName());
    }
    expect(names.size).toBe(500);
  });
  test("retries collisions until it finds an unused combination", () => {
    configureSubagentInstanceNamesForTest({
      adjectives: ["able", "brave"],
      nouns: ["falcon", "otter"],
      randomSource: () => 0,
    });
    expect(generateSubagentInstanceName()).toBe("able-falcon");
    expect(generateSubagentInstanceName()).toBe("able-otter");
    expect(generateSubagentInstanceName()).toBe("brave-falcon");
    expect(generateSubagentInstanceName()).toBe("brave-otter");
  });
  test("throws a clear error when combinations become exhausted", () => {
    configureSubagentInstanceNamesForTest({
      adjectives: ["able"],
      nouns: ["falcon"],
      randomSource: () => 0,
    });
    expect(generateSubagentInstanceName()).toBe("able-falcon");
    expect(() => generateSubagentInstanceName()).toThrow(
      "No unused subagent instance names remain for this session.",
    );
  });
});
