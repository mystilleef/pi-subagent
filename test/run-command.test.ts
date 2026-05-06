import { expect, test } from "bun:test";
import path from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  clearProgressState,
  createProgressState,
  getProgressState,
  patchProgressState,
} from "../src/progress.js";
import {
  type FakeTheme,
  type RegisteredMessageRenderer,
  type SendMessageArg,
  setupHooks,
  setupTest,
} from "./helpers.js";

setupHooks();

test("run slash command sends one subagent-progress message and one final result", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  expect(runCommand).toBeDefined();
  const handlerPromise = runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const messagesSentBeforeChildExit = sentMessages.length;
  await handlerPromise;
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  const details = sentMessages[0]?.details as
    | { requestId?: unknown }
    | undefined;
  if (typeof details?.requestId !== "string")
    throw new Error("progress request id missing");
  expect(details.requestId.length).toBeGreaterThan(0);
  expect(messagesSentBeforeChildExit).toBe(1);
});

test("run slash command patches context window into progress state", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"provider":"openai","model":"gpt-4o-mini","usage":{"input":10,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":30,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const details = sentMessages[0]?.details as
    | { requestId?: string }
    | undefined;
  const requestId = details?.requestId;
  if (!requestId) throw new Error("progress request id missing");
  const state = getProgressState(requestId);
  expect(state?.contextTokens).toBe(30);
  expect(state?.contextWindowTokens).toBe(128000);
  clearProgressState(requestId);
});

test("run slash command keeps context window unknown without metadata", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":30,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const details = sentMessages[0]?.details as
    | { requestId?: string }
    | undefined;
  const requestId = details?.requestId;
  if (!requestId) throw new Error("progress request id missing");
  const state = getProgressState(requestId);
  expect(state?.contextTokens).toBe(30);
  expect(state?.contextWindowTokens).toBeUndefined();
  clearProgressState(requestId);
});

test("patchProgressState missing usage fields keeps existing context window", () => {
  const requestId = "manual-progress-context-window";
  clearProgressState(requestId);
  createProgressState(requestId, "agent", "task");
  patchProgressState(requestId, { contextWindowTokens: 128000 });
  patchProgressState(requestId, { inputTokens: 10 });
  expect(getProgressState(requestId)?.contextWindowTokens).toBe(128000);
  clearProgressState(requestId);
});

test("run slash command does not append progress refresh messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
sleep 1.1
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const progressMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-progress",
  );
  expect(progressMessages).toHaveLength(1);
  for (const message of progressMessages) {
    expect(message.content).toBe("");
    expect(
      Object.keys((message.details as Record<string, unknown>) ?? {}),
    ).toEqual(["requestId"]);
  }
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  const countAfterCompletion = sentMessages.length;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(sentMessages).toHaveLength(countAfterCompletion);
});

test("/run without task sends an agent-default prompt instead of empty Task label", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
  expect(argsText).not.toContain("Task:");
  expect(argsText).toContain("Run according to your system prompt");
});

test("/run with task preserves Task label", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang explicit task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
  expect(argsText).toContain("Task: explicit task");
});

test("getArgumentCompletions returns matching agent suggestions", async () => {
  const { cwd } = await setupTest();
  const { tool } = await setupTest();
  const runCommand = tool.registeredCommands.get("run");
  expect(runCommand?.getArgumentCompletions).toBeDefined();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "test-agent.md"),
    `---\nname: test-agent\ndescription: test\n---\nPrompt`,
  );
  const originalCwd = process.cwd;
  process.cwd = () => cwd;
  try {
    expect(await runCommand?.getArgumentCompletions?.("te")).toEqual([
      { value: "test-agent", label: "test-agent" },
    ]);
    expect(await runCommand?.getArgumentCompletions?.("x")).toEqual([]);
  } finally {
    process.cwd = originalCwd;
  }
});

test("/run progress onUpdate mutates state without refresh messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const statusUpdates: [string, string | undefined][] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  expect(runCommand).toBeDefined();
  await runCommand?.handler("hang test task", {
    cwd,
    ui: {
      notify: () => {},
      setStatus: (key: string, text: string | undefined) =>
        statusUpdates.push([key, text]),
    },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.toolCount).toBeGreaterThan(0);
  expect(statusUpdates.length).toBeGreaterThan(0);
  expect(statusUpdates.some(([, text]) => text === undefined)).toBe(true);
});

test("/run progress refresh does not emit fallback notifications", async () => {
  const notifyCalls: string[] = [];
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"tc-2","arguments":{"path":"/tmp/x"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    hasUI: true,
    ui: {
      notify: (msg: string) => notifyCalls.push(msg),
    },
  } as unknown as ExtensionCommandContext);
  expect(notifyCalls).toHaveLength(0);
});

test("/run fallback is silent when hasUI is false", async () => {
  const notifyCalls: string[] = [];
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    hasUI: false,
    ui: {
      notify: (msg: string) => notifyCalls.push(msg),
    },
  } as unknown as ExtensionCommandContext);
  expect(notifyCalls).toHaveLength(0);
});

test("/run success marks state success with trimmed finalOutput and clears transient fields", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  expect(sentMessages.at(-1)?.content).toBe("done");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.finalOutput).toBe("completed task");
  expect(state?.lastToolPreview).toBeUndefined();
});

test("/run empty success sends no-output text and stores no-output final state", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"   "}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  expect(sentMessages.at(-1)?.content).toBe("(no output)");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.finalOutput).toBe("(no output)");
  expect(state?.lastToolPreview).toBeUndefined();
});

test("/run child failure marks state error with concise error text and clears transient fields", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' 'child exploded' >&2
exit 7
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(1);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("error");
  expect(state?.errorText).toBeTruthy();
  expect(state?.lastToolPreview).toBeUndefined();
});

test("/run project-agent denial marks state cancelled", async () => {
  const { cwd } = await setupTest();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "proj-agent.md"),
    `---
name: proj-agent
description: Project agent
---
Prompt`,
  );
  const sentMessages: SendMessageArg[] = [];
  const { tool } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("proj-agent task", {
    cwd,
    hasUI: true,
    ui: { notify: () => {}, confirm: async () => false },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(1);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("cancelled");
});

test("/run final result uses semantic content without truncating details", async () => {
  const sentMessages: SendMessageArg[] = [];
  const longOutcome = `shipped ${"x".repeat(2600)}`;
  const finalOutput = `${longOutcome}\nAll tests pass.\nNo rollback needed.`;
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "tc-1", arguments: { command: "SECRET_COMMAND" } }] } })}'
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalOutput }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } })}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const resultMessage = sentMessages.at(-1);
  expect(resultMessage?.content).toContain(longOutcome);
  expect(resultMessage?.content).not.toContain("SECRET_COMMAND");
  expect(resultMessage?.content).not.toContain("[truncated:");
  const details = resultMessage?.details as {
    results?: { finalOutput?: string }[];
  };
  expect(details.results?.[0]?.finalOutput).toBe(finalOutput);
});

test("/run debug includes child messages in final details", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "tc-1", arguments: { command: "DEBUG_COMMAND" } }] } })}'
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Outcome: done" }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } })}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("--debug hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const details = sentMessages.at(-1)?.details as {
    results?: { messages?: unknown[] }[];
  };
  expect(details.results?.[0]?.messages).toHaveLength(2);
  expect(JSON.stringify(details.results?.[0]?.messages)).toContain(
    "DEBUG_COMMAND",
  );
});

test("/run context hygiene: sent message content excludes child internals", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
node -e "process.stderr.write('STDERR_SECRET');console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',name:'bash',id:'tc-1',arguments:{command:'TOOL_SECRET'}}]}}));console.log(JSON.stringify({type:'tool_result_end',message:{role:'toolResult',content:[{type:'text',text:'TOOL_RESULT_SECRET'}]}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],usage:{input:1,output:1,totalTokens:2,cost:{total:0}}}}));console.log(JSON.stringify({type:'agent_end'}));"
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(2);
  for (const message of sentMessages) {
    const content = String(message.content ?? "");
    expect(content).not.toContain("TOOL_SECRET");
    expect(content).not.toContain("TOOL_RESULT_SECRET");
    expect(content).not.toContain("STDERR_SECRET");
    expect(content).not.toContain("toolCall");
    expect(content).not.toContain("requestId");
  }
  expect(sentMessages[0]?.content).toBe("");
  expect(sentMessages[0]?.details).toEqual({
    requestId: (sentMessages[0]?.details as { requestId?: string }).requestId,
  });
  expect(sentMessages.at(-1)?.content).toBe("done");
  const resultDetails = JSON.stringify(sentMessages.at(-1)?.details ?? {});
  expect(resultDetails).not.toContain("TOOL_SECRET");
  expect(resultDetails).not.toContain("TOOL_RESULT_SECRET");
  expect(resultDetails).not.toContain("STDERR_SECRET");
  expect(resultDetails).not.toContain('"messages"');
});

test("/run context hygiene: sendMessage details has only requestId and progress state has no raw child data", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
node -e "const args={command:'A'.repeat(80),secret:'SECRET_VALUE'};console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',name:'bash',id:'tc-1',arguments:args}]}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],usage:{input:1,output:1,totalTokens:2,cost:{total:0}}}}));console.log(JSON.stringify({type:'agent_end'}));"
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(2);
  const msgDetails = sentMessages[0]?.details as Record<string, unknown>;
  expect(Object.keys(msgDetails)).toEqual(["requestId"]);
  const requestId = msgDetails.requestId as string;
  const state = getProgressState(requestId);
  expect(state).toBeDefined();
  const stateStr = JSON.stringify(state);
  expect(stateStr).not.toContain('"messages"');
  expect(stateStr).not.toContain("SECRET_VALUE");
  expect((state?.lastToolPreview ?? "").length).toBeLessThan(80);
});

test("/run error hygiene: errorText is concise when child stderr is large", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
node -e "process.stderr.write('E'.repeat(5000));process.exit(7);"
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("error");
  expect((state?.errorText ?? "").length).toBeLessThanOrEqual(300);
});

test("/run accumulates toolCount across multiple distinct tool calls", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"tc-2","arguments":{"path":"/tmp/x"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"write","id":"tc-3","arguments":{"path":"/tmp/y"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.toolCount).toBe(3);
  expect(state?.status).toBe("success");
});

test("/run retains progress state after terminal transition", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state).toBeDefined();
  expect(state?.status).toBe("success");
  const stateAgain = getProgressState(requestId);
  expect(stateAgain).toBeDefined();
  expect(stateAgain?.requestId).toBe(requestId);
});

test("/run abort marks state cancelled with signal from ctx", async () => {
  const controller = new AbortController();
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  setTimeout(() => controller.abort(), 50);
  await runCommand?.handler("hang task", {
    cwd,
    signal: controller.signal,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("cancelled");
});

test("/run success sends final result message with final output", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  expect(sentMessages.at(-1)?.content).toBe("done");
});

test("/run final result message renderer hides header and keeps success background", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const renderer = tool.registeredMessageRenderers.get("subagent-result");
  if (!renderer) throw new Error("subagent-result renderer missing");
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderer(
    sentMessages.at(-1) as Parameters<RegisteredMessageRenderer>[0],
    { expanded: false },
    fakeTheme as Parameters<RegisteredMessageRenderer>[2],
  ) as unknown as { render: (width: number) => string[] };
  const renderedText = rendered.render(10000).join("\n");
  expect(renderedText).not.toContain("[success]✓[/success]");
  expect(renderedText).not.toContain("[toolTitle]*hang*[/toolTitle]");
  expect(renderedText).toContain("[toolOutput]done[/toolOutput]");
  expect(
    rendered
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolSuccessBg]") &&
          line.endsWith("[/toolSuccessBg]"),
      ),
  ).toBe(true);
});

test("/run final result keeps semantic content while renderer uses full final output", async () => {
  const sentMessages: SendMessageArg[] = [];
  const finalOutput =
    "Hello! I can help.\nError: noisy stack line\nSemantic summary";
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalOutput }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } })}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const renderer = tool.registeredMessageRenderers.get("subagent-result");
  if (!renderer) throw new Error("subagent-result renderer missing");
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderer(
    sentMessages.at(-1) as Parameters<RegisteredMessageRenderer>[0],
    { expanded: false },
    fakeTheme as Parameters<RegisteredMessageRenderer>[2],
  ) as unknown as { render: (width: number) => string[] };
  const renderedText = rendered.render(10000).join("\n");
  expect(sentMessages.at(-1)?.content).toBe("Semantic summary");
  expect(renderedText).toContain("[toolOutput]Hello! I can help.[/toolOutput]");
  expect(renderedText).toContain(
    "[toolOutput]Error: noisy stack line[/toolOutput]",
  );
  expect(renderedText).toContain("[toolOutput]Semantic summary[/toolOutput]");
});
