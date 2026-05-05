import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import readline from "node:readline";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig, ThinkingLevel } from "./agents.js";
import { extractSemanticToolTarget } from "./summary.js";
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

const MAX_STDERR_BYTES = 10_000;

type RuntimeResult = SingleResult & { messages: Message[] };

const MAX_SUBAGENT_DEPTH = 3;
const TOOL_RESULT_FAILED_MESSAGE = "Subagent tool result failed.";
const RESULT_FORMAT_INSTRUCTIONS = `Optimize your final answer for the main agent with aggressive agent, token, and context efficiency.
Return only decision-useful facts. Do not include reasoning, logs, raw tool output, greetings, apologies, or transcript details.
Compress every field aggressively.
Use this concise markdown format:
Outcome: <a single, brief, concise phrase summarizing the result>
Changed: <changed paths, or none>
Verification: <a single, brief, concise phrase proving the outcome>
Next: <single next action, or none>

If the task failed, use this format:
Outcome: <a single, brief, concise phrase summarizing the failure>
Cause: <short root cause or blocker>
Verification: <a single, brief, concise phrase proving the failure>
Next: <single fix or retry action>

Do not paste logs or raw output. Summarize verification in one concise statement.
Mention commands/checks only when they increase confidence.
Use plain values; avoid backticks unless needed.
Use none for empty fields.`;

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
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
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
    proc.on("error", () => {
      exitCode = 1;
      exited = true;
      done();
    });
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
  makeDetails: (
    results: RuntimeResult[],
    options?: { includeMessages?: boolean },
  ) => SubagentDetails,
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
  const startedAt = Date.now();
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
  const nextUpdateText = () => {
    const msgs = currentResult.messages;
    const last = msgs.findLast((m) => m.role === "assistant");
    const toolCall = Array.isArray(last?.content)
      ? last.content.findLast((p) => p.type === "toolCall")
      : undefined;
    if (!toolCall) return "(running...)";
    const target = extractSemanticToolTarget(
      toolCall.name,
      toolCall.arguments ?? {},
    );
    return target ? `${toolCall.name}: ${target}` : toolCall.name;
  };
  const emitUpdate = () => {
    const msgs = currentResult.messages;
    let anchorIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (
        m?.role === "assistant" &&
        m.content.some(
          (c) => c.type === "text" && (c as { text?: string }).text?.trim(),
        )
      ) {
        anchorIdx = i;
        break;
      }
    }
    const recentMessages =
      anchorIdx >= 0 ? msgs.slice(anchorIdx) : msgs.slice(-5);
    const snapshot = { ...currentResult, messages: recentMessages };
    onUpdate?.({
      content: [{ type: "text", text: nextUpdateText() }],
      details: makeDetails([snapshot], { includeMessages: true }),
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
    const taskPrompt = task
      ? `Task: ${task}`
      : "Run according to your system prompt. If no explicit task was provided, use the default context described there.";
    args.push(`${taskPrompt}\n\n${RESULT_FORMAT_INSTRUCTIONS}`);
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: defaultCwd,
      shell: invocation.command === "pi" && process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...subagentDepthEnv() },
    });
    const processDone = waitForSubagentProcess(proc);
    let spawnError: Error | undefined;
    proc.once("error", (error) => {
      spawnError = error;
      if (currentResult.stderr.length < MAX_STDERR_BYTES)
        currentResult.stderr += error.message;
    });
    let wasAborted = false;
    const addMessage = (msg: Message) => {
      currentResult.messages.push(msg);
      currentResult.finalOutput = truncateOutput(
        getFinalOutput(currentResult.messages),
      );
      if (msg.role === "toolResult" && msg.isError) {
        currentResult.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
      } else if (currentResult.errorMessage === TOOL_RESULT_FAILED_MESSAGE) {
        currentResult.errorMessage = undefined;
      }
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
        if (!currentResult.model && msg.model) currentResult.model = msg.model;
        if (msg.stopReason) currentResult.stopReason = msg.stopReason;
        if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
      }
    };
    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (
          (event.type === "message_end" || event.type === "tool_result_end") &&
          event.message
        ) {
          addMessage(event.message as Message);
          emitUpdate();
        }
        if (event.type === "agent_end") {
          if (
            currentResult.messages.length === 0 &&
            Array.isArray(event.messages)
          ) {
            for (const msg of event.messages as Message[]) addMessage(msg);
            emitUpdate();
          }
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
        if (currentResult.stderr.length < MAX_STDERR_BYTES)
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
    currentResult.exitCode = (await processDone) ?? 0;
    currentResult.durationMs = Date.now() - startedAt;
    if (spawnError) currentResult.exitCode = 1;
    if (detectMessageError(currentResult.messages)) {
      currentResult.errorMessage ||= TOOL_RESULT_FAILED_MESSAGE;
    }
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
