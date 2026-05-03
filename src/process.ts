import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import readline from "node:readline";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig, ThinkingLevel } from "./agents.js";
import type {
  OnUpdateCallback,
  SingleResult,
  SubagentDetails,
} from "./types.js";
import { getFinalOutput } from "./ui.js";
import {
  detectMessageError,
  getPiInvocation,
  getSubagentDepth,
  resolveAgentSkillArgs,
  subagentDepthEnv,
  truncateOutput,
  writePromptToTempFile,
} from "./utils.js";

type RuntimeResult = SingleResult & { messages: Message[] };

const MAX_SUBAGENT_DEPTH = 3;

async function waitForSubagentProcess(
  proc: ChildProcess,
  idleMs = 100,
  hardMs = 5_000,
): Promise<number | null> {
  return new Promise((resolve) => {
    let exitCode: number | null = null;
    let exited = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;

    const done = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(exitCode);
    };

    const destroyStreams = () => {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    };

    const armIdleTimer = () => {
      if (!exited) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(destroyStreams, idleMs);
      idleTimer.unref?.();
    };

    proc.on("close", done);

    proc.on("exit", (code) => {
      exitCode = code;
      exited = true;
      armIdleTimer();
      hardTimer = setTimeout(destroyStreams, hardMs);
      hardTimer.unref?.();
    });

    proc.stdout?.on("data", armIdleTimer);
    proc.stderr?.on("data", armIdleTimer);
  });
}

export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: RuntimeResult[]) => SubagentDetails,
  parentModel: { provider: string; id: string } | undefined,
  parentThinking: ThinkingLevel,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return createErrorResult(
      agentName,
      "unknown",
      task,
      `Unknown agent: "${agentName}". Available agents: ${available}.`,
    );
  }

  const depth = getSubagentDepth();
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return createErrorResult(
      agentName,
      agent.source,
      task,
      `Subagent nesting limit reached (depth ${depth}/${MAX_SUBAGENT_DEPTH}).`,
    );
  }

  const thinking = agent.thinking ?? parentThinking;
  const modelDisplay = parentModel
    ? `${parentModel.provider}/${parentModel.id}${thinking ? `:${thinking}` : ""}`
    : thinking
      ? `thinking:${thinking}`
      : undefined;

  const resolvedSkills = agent.skills
    ? await resolveAgentSkillArgs(defaultCwd, agent.skills)
    : { args: [] };

  if ("error" in resolvedSkills) {
    return createErrorResult(
      agentName,
      agent.source,
      task,
      resolvedSkills.error,
      modelDisplay,
    );
  }

  const currentResult: RuntimeResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    finalOutput: "",
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: modelDisplay,
  };

  let lastEmittedFinalOutput = "";
  let emittedRunningUpdate = false;

  const nextUpdateText = () => {
    const finalOutput = currentResult.finalOutput;
    if (!finalOutput) {
      if (emittedRunningUpdate) return "";
      emittedRunningUpdate = true;
      return "(running...)";
    }

    if (finalOutput.startsWith(lastEmittedFinalOutput)) {
      const delta = finalOutput.slice(lastEmittedFinalOutput.length);
      lastEmittedFinalOutput = finalOutput;
      return truncateOutput(delta);
    }

    lastEmittedFinalOutput = finalOutput;
    return truncateOutput(finalOutput);
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: nextUpdateText(),
        },
      ],
      details: makeDetails([currentResult]),
    });
  };

  let tmpPrompt: { dir: string; filePath: string } | null = null;
  try {
    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (parentModel)
      args.push("--provider", parentModel.provider, "--model", parentModel.id);
    args.push("--thinking", thinking);
    if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
    if (agent.skills) args.push("--no-skills", ...resolvedSkills.args);

    if (agent.systemPrompt.trim()) {
      tmpPrompt = await writePromptToTempFile(agent.name, agent.systemPrompt);
      args.push("--append-system-prompt", tmpPrompt.filePath);
    }

    args.push(`Task: ${task}`);

    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: defaultCwd,
      shell: invocation.command === "pi" && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...subagentDepthEnv() },
    });

    let wasAborted = false;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (
          (event.type === "message_end" || event.type === "tool_result_end") &&
          event.message
        ) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);
          currentResult.finalOutput = getFinalOutput(currentResult.messages);
          currentResult.errorMessage = detectMessageError(
            currentResult.messages,
          )
            ? currentResult.errorMessage || "Subagent tool result failed."
            : undefined;

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model)
              currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "agent_end") {
          proc.kill("SIGTERM");
        }
      } catch {
        /* ignore invalid JSON */
      }
    };

    if (proc.stdout) {
      readline.createInterface({ input: proc.stdout }).on("line", processLine);
    }

    if (proc.stderr) {
      proc.stderr.on("data", (data) => {
        if (currentResult.stderr.length < 10_000)
          currentResult.stderr += data.toString();
      });
    }

    if (signal) {
      const onAbort = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    currentResult.exitCode = (await waitForSubagentProcess(proc)) ?? 0;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPrompt) {
      try {
        await fs.promises.unlink(tmpPrompt.filePath);
        await fs.promises.rmdir(tmpPrompt.dir);
      } catch {
        /* ignore */
      }
    }
  }
}

function createErrorResult(
  agent: string,
  source: "user" | "project" | "unknown",
  task: string,
  error: string,
  model?: string,
): SingleResult {
  return {
    agent,
    agentSource: source,
    task,
    exitCode: 1,
    finalOutput: "",
    stderr: error,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model,
  };
}
