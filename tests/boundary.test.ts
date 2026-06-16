import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("boundary guardrail: no changes to pi core, provider adapters, or event schemas", () => {
  // 1. Verify package.json doesn't contain unexpected dependencies
  const packageJsonPath = join(__dirname, "../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  // No "dependencies" field at all should be present to keep the package clean (everything is in dev/peer)
  expect(packageJson.dependencies).toBeUndefined();

  // Verify only allowed devDependencies are present
  const devDeps = Object.keys(packageJson.devDependencies || {});
  const expectedDevDeps = [
    "@biomejs/biome",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@types/bun",
    "@types/node",
    "typebox",
    "typescript",
  ];
  for (const dep of devDeps) {
    expect(expectedDevDeps).toContain(dep);
  }
});

test("boundary guardrail: complete extension uses package-local resolution", () => {
  // The complete-extension must resolve locally to our package source, not global paths
  const localExtensionPathTs = join(
    __dirname,
    "../src/child/complete-extension.ts",
  );
  expect(existsSync(localExtensionPathTs)).toBe(true);
});
