import * as fs from "node:fs";
import type { AgentConfig } from "../agent/agents.js";
import { writePromptToTempFile } from "../shared/utils.js";

export type TempPrompt = { dir: string; filePath: string };

export type PromptSetupResult =
  | { tmpPrompt: TempPrompt | null }
  | { error: unknown };

export async function cleanupTempPrompt(tmpPrompt: TempPrompt): Promise<void> {
  try {
    await fs.promises.unlink(tmpPrompt.filePath);
    await fs.promises.rmdir(tmpPrompt.dir);
  } catch {
    /* temp file cleanup failures are non-fatal; OS will clean up eventually */
  }
}

export function beginPromptSetup(
  agent: AgentConfig,
): Promise<PromptSetupResult> {
  if (!agent.systemPrompt.trim()) return Promise.resolve({ tmpPrompt: null });
  return writePromptToTempFile(agent.name, agent.systemPrompt).then(
    (tmpPrompt) => ({ tmpPrompt }),
    (error: unknown) => ({ error }),
  );
}

export async function cleanupPromptSetupResult(
  setup: PromptSetupResult,
): Promise<void> {
  if ("tmpPrompt" in setup && setup.tmpPrompt) {
    await cleanupTempPrompt(setup.tmpPrompt);
  }
}
