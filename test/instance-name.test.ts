import { describe, expect, test } from "bun:test";
import { generateSubagentInstanceName } from "../src/shared/instance-name.js";

describe("generateSubagentInstanceName", () => {
  test("generates lower-case kebab adjective-noun names", () => {
    const name = generateSubagentInstanceName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });
});
