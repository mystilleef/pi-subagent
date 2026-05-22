import { expect, test } from "bun:test";
import type { AgentConfig } from "../src/agent/agents.js";
import { runSingleAgent } from "../src/child/process.js";
import {
  appendSubagentResultContract,
  SUBAGENT_RESULT_CONTRACT,
} from "../src/child/prompt-contract.js";
import type { SubagentDetails } from "../src/shared/types.js";
import { setupHooks, setupTest } from "./helpers.js";

setupHooks();

const makeDetails = (results: SubagentDetails["results"]): SubagentDetails => ({
  mode: "single",
  agentScope: "both",
  projectAgentsDir: null,
  results,
});

const hangAgent: AgentConfig = {
  name: "hang",
  description: "Test agent",
  thinking: "off",
  systemPrompt: "Test agent prompt.",
  source: "user",
  filePath: "hang.md",
};

test("runSingleAgent reports unknown agents with available names", async () => {
  const result = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "missing",
    "task",
    undefined,
    undefined,
    makeDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.agentSource).toBe("unknown");
  expect(result.stderr).toBe(
    'Unknown agent: "missing". Available agents: "hang".',
  );
});

test("runSingleAgent cancels cleanly with nonstandard abort reason", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeDetails,
    undefined,
    "off",
  );
  controller.abort(null);
  await expect(promise).rejects.toThrow("Subagent was aborted");
});

test("SUBAGENT_RESULT_CONTRACT preserves outcome-only result contract", () => {
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(
    /End your final response with exactly one line:/,
  );
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(
    /^\s*- Outcome: <short, single, compact lower-case sentence>\./m,
  );
  expect(SUBAGENT_RESULT_CONTRACT).not.toMatch(/standardized result output/i);
});

test("appendSubagentResultContract appends contract to prompt", () => {
  const result = appendSubagentResultContract("Task: foo");
  expect(result.startsWith("Task: foo\n\n")).toBe(true);
  expect(result.endsWith(SUBAGENT_RESULT_CONTRACT)).toBe(true);
});
