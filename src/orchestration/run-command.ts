import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { startSubagentJob } from "./subagent-orchestrator.js";

export function parseRunArgs(
  args: string,
): { agentName: string; task: string; debug: boolean } | undefined {
  const input = args.trim();
  if (!input) return undefined;
  const debug = input.startsWith("--debug ");
  const command = debug ? input.slice("--debug ".length).trim() : input;
  if (!command) return undefined;
  const firstSpace = command.indexOf(" ");
  if (firstSpace === -1) return { agentName: command, task: "", debug };
  return {
    agentName: command.slice(0, firstSpace),
    task: command.slice(firstSpace + 1).trim(),
    debug,
  };
}

export async function runCommandHandler(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  const parsed = parseRunArgs(args);
  if (!parsed) {
    ctx.ui.notify("Usage: /run <agent> [task]", "error");
    return;
  }
  const { agentName, task, debug } = parsed;
  const result = await startSubagentJob(
    pi,
    ctx,
    { agent: agentName, task, debug },
    ctx.signal,
  );
  if (result.kind === "not_found") {
    ctx.ui.notify(`Unknown agent: ${agentName}`, "error");
  } else if (result.kind === "cancelled") {
    ctx.ui.notify("Cancelled", "info");
  }
}
