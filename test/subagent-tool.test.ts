import { expect, test } from "bun:test";
import { chmod, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TextContent } from "@mariozechner/pi-ai";
import type {
  AgentToolResult,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { SubagentDetails } from "../src/types.js";
import {
  executeSubagent,
  getSubagentTool,
  setupFakePi,
  setupHooks,
  setupTest,
  shellQuote,
  timeoutAfter,
} from "./helpers.js";

setupHooks();

test("subagent tool accepts omitted task", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
  expect((result.content[0] as TextContent).text).toBe("done");
  expect(argsText).not.toContain("Task:");
});

test("subagent tool injects current result format", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "ship it" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
  expect(argsText).toContain("Task: ship it");
  expect(argsText).toContain(
    "When your task is complete, summarize its result.",
  );
  expect(argsText).toContain(
    "Optimize the summary for token and context efficiency.",
  );
  expect(argsText).toContain(
    "Add an empty line between paragraphs, headings and sections.",
  );
  expect(argsText).toContain(
    "Use elegant, well-structured, idiomatic markdown.",
  );
  expect(argsText).toContain("End your final response with exactly one line:");
  expect(argsText).toContain(
    "Outcome: <short, single, compact lower-case sentence>.",
  );
  expect(argsText).toContain(
    "Outcome summarizes the result of your task in a single sentence.",
  );
  expect(argsText).not.toContain("Changed:");
  expect(argsText).not.toContain("Cause:");
});

test("subagent resolves when fake pi exits normally", async () => {
  const result = await executeSubagent("normal");
  expect((result.content[0] as TextContent).text).toEqual("done");
});

test("subagent resolves when fake pi emits agent_end but stays alive", async () => {
  const controller = new AbortController();
  const run = executeSubagent("agent-end-no-exit", controller.signal);
  const result = await Promise.race([
    run,
    timeoutAfter(500, () => controller.abort()),
  ]);
  expect((result.content[0] as TextContent).text).toEqual("done");
});

test("subagent falls back to agent_end messages", async () => {
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"from agent_end"}],"usage":{"input":2,"output":3,"totalTokens":5,"cost":{"total":0.01}}}]}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toEqual("from agent_end");
  expect(result.details?.results[0]?.usage.input).toBe(2);
});

test("subagent keeps long semantic parent fields without truncation", async () => {
  const { binDir, cwd } = await setupFakePi();
  const longOutcome = `shipped ${"x".repeat(2_001)}`;
  const finalOutput = `${longOutcome}\nVerification: bun test\nNext: none`;
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } },
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const text = (result.content[0] as TextContent).text;
  expect(text).toBe(`${longOutcome}\nVerification: bun test\nNext: none`);
  expect(text).not.toContain("[truncated: full output available in details]");
  expect(result.details?.results[0]?.finalOutput).toBe(finalOutput);
});

test("subagent returns semantic parent text while preserving full details", async () => {
  const { binDir, cwd } = await setupFakePi();
  const finalOutput =
    "Migration applied to 3 tables.\nAll tests pass.\nNo rollback needed.\nExtra line.";
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
      model: "gpt-4",
      usage: {
        input: 3,
        output: 4,
        totalTokens: 7,
        cost: { total: 0.002 },
      },
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toBe(
    "Migration applied to 3 tables.\nAll tests pass.\nNo rollback needed.\nExtra line.",
  );
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.finalOutput).toBe(finalOutput);
  expect(details.results[0]?.usage.input).toBe(3);
  expect(details.results[0]?.usage.output).toBe(4);
  expect(details.results[0]?.durationMs).toEqual(expect.any(Number));
  expect(details.results[0]?.stderr).toBe("");
  expect(details.results[0]?.errorMessage).toBeUndefined();
  expect(details.results[0]?.messages).toBeUndefined();
});

test("subagent failure error uses semantic final output before generic error", async () => {
  const { binDir, cwd } = await setupFakePi();
  const finalOutput =
    "Outcome: failed at verify\nCause: parsed cause\nVerification: parsed verification\nNext: parsed next";
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
    },
  });
  const toolResultEnd = JSON.stringify({
    type: "message_end",
    message: { role: "toolResult", content: [], isError: true },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' ${shellQuote(toolResultEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  await expect(
    tool.execute(
      "test-tool-call",
      { agent: "hang", task: "test" },
      undefined,
      undefined,
      { cwd, hasUI: false } as unknown as ExtensionContext,
    ),
  ).rejects.toThrow(
    "Agent failed: Outcome: failed at verify\nCause: parsed cause\nVerification: parsed verification",
  );
});

test("subagent rejects assistant errorMessage without error stop reason", async () => {
  const { binDir, cwd } = await setupFakePi();
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "looks successful" }],
      stopReason: "stop",
      errorMessage: "recorded child failure",
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  process.env.PI_SUBAGENT_DEPTH = "0";
  await expect(
    tool.execute(
      "test-tool-call",
      { agent: "hang", task: "test" },
      undefined,
      undefined,
      { cwd, hasUI: false } as unknown as ExtensionContext,
    ),
  ).rejects.toThrow("Agent stop: recorded child failure");
});

test("subagent reports spawn errors", async () => {
  const { binDir, cwd } = await setupFakePi();
  await unlink(path.join(binDir, "pi"));
  process.env.PATH = binDir;
  const tool = getSubagentTool();
  const promise = tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await expect(promise).rejects.toThrow(/Executable not found|spawn pi ENOENT/);
});

test("subagent handles unknown agent", async () => {
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool();
  const promise = tool.execute(
    "test-tool-call",
    { agent: "non-existent", task: "whatever" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await expect(promise).rejects.toThrow('Unknown agent: "non-existent"');
});

test("subagent respects agentScope", async () => {
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-agent.md"),
    `---
name: project-agent
description: Project agent
---
System prompt`,
  );
  const tool = getSubagentTool();
  // Explicit "user" scope should NOT find project agent
  const promiseUser = tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "user" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await expect(promiseUser).rejects.toThrow();
  // Both scope should find project agent
  const resultBoth = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "both" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      ui: { confirm: async () => true },
    } as unknown as ExtensionContext,
  );
  expect((resultBoth.content[0] as TextContent).text).toBe("done");
});

test("subagent requires confirmation for project agents with UI", async () => {
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-agent.md"),
    `---
name: project-agent
description: Project agent
---
System prompt`,
  );
  const tool = getSubagentTool();
  let confirmed = false;
  const fakeUI = {
    confirm: async () => {
      confirmed = true;
      return false;
    },
  };
  const result = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "both" },
    undefined,
    undefined,
    { cwd, hasUI: true, ui: fakeUI } as unknown as ExtensionContext,
  );
  expect(confirmed).toBe(true);
  expect((result.content[0] as TextContent).text).toContain("Canceled");
});

test("subagent handles abort", async () => {
  const { binDir, cwd } = await setupFakePi();
  // Override pi to hang
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  );
  const tool = getSubagentTool();
  const controller = new AbortController();
  const promise = tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    controller.signal,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  setTimeout(() => controller.abort(), 100);
  try {
    await promise;
    expect.unreachable();
  } catch (e: unknown) {
    expect((e as Error).message).toBe("Subagent was aborted");
  }
});

test("subagent captures pi output including usage and model", async () => {
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"provider":"openai","model":"gpt-4o-mini","usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.001}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toBe("Outcome: hello");
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.usage.input).toBe(10);
  expect(details.results[0]?.finalOutput).toBe("Outcome: hello");
  expect(details.results[0]?.messages).toBeUndefined();
  expect(details.results[0]?.usage.contextWindowTokens).toBe(128000);
  if (details.results[0]?.model !== "gpt-4o-mini")
    expect(details.results[0]?.model).toBe("thinking:off");
  const debugResult = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const debugDetails = debugResult.details as SubagentDetails;
  expect(debugDetails.results[0]?.messages).toHaveLength(1);
});

test("subagent leaves context window unknown for unknown metadata", async () => {
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"provider":"unknown-provider","model":"unknown-model","usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.001}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.usage.contextWindowTokens).toBeUndefined();
});

test("subagent updates correctly format tool calls and final text", async () => {
  const { binDir, cwd } = await setupFakePi();
  // We mock a pi executable that emits some intermediate events
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[]}}'
printf '%s\n' '{"type":"content_block_start","index":0,"contentBlock":{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"user","content":[]}}'
printf '%s\n' '{"type":"content_block_start","index":0,"contentBlock":{"type":"text","text":"result"}}'
printf '%s\n' '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"result"}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[]}}'
printf '%s\n' '{"type":"content_block_start","index":0,"contentBlock":{"type":"text","text":"final"}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const updates: AgentToolResult<SubagentDetails>[] = [];
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    (update) => updates.push(update),
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const texts = updates.map((u) => (u.content[0] as TextContent)?.text);
  expect(updates.length).toBeGreaterThan(0);
  expect(texts.some((t) => t === "(running...)")).toBe(true);
  expect(texts.some((t) => t === "bash: ls")).toBe(true);
  expect(texts.indexOf("(running...)")).toBeLessThan(texts.indexOf("bash: ls"));
});

test("streaming updates emit tool-call format instead of output text", async () => {
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const updates: AgentToolResult<SubagentDetails>[] = [];
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    (update) => updates.push(update),
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const texts = updates.map((u) => (u.content[0] as TextContent)?.text);
  expect(texts.some((t) => t === "bash: ls")).toBe(true);
  expect(texts.some((t) => t === "final")).toBe(false);
});

test("streaming updates hide unknown tool arguments", async () => {
  const { binDir, cwd } = await setupFakePi();
  const unknownToolEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "unknown",
          id: "1",
          arguments: {
            token: "SECRET_TOKEN",
            password: "SECRET_PASSWORD",
            nested: { value: "SECRET_NESTED" },
          },
        },
      ],
    },
  });
  const bashEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "bash",
          id: "2",
          arguments: { command: "ls" },
        },
      ],
    },
  });
  const readEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "read",
          id: "3",
          arguments: { path: "src/process.ts" },
        },
      ],
    },
  });
  const subagentEvent = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "subagent",
          id: "4",
          arguments: {
            agent: "reviewer",
            task: "check safety",
            agentScope: "both",
          },
        },
      ],
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(unknownToolEvent)}
printf '%s\n' ${shellQuote(bashEvent)}
printf '%s\n' ${shellQuote(readEvent)}
printf '%s\n' ${shellQuote(subagentEvent)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const updates: AgentToolResult<SubagentDetails>[] = [];
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    (update) => updates.push(update),
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const texts = updates.map((u) => (u.content[0] as TextContent)?.text);
  expect(texts).toContain("unknown");
  expect(texts).toContain("bash: ls");
  expect(texts).toContain("read: src/process.ts");
  expect(texts).toContain("subagent: reviewer check safety [both]");
  expect(texts.join("\n")).not.toContain("SECRET_TOKEN");
  expect(texts.join("\n")).not.toContain("SECRET_PASSWORD");
  expect(texts.join("\n")).not.toContain("SECRET_NESTED");
  expect(texts).not.toContain("unknown: ");
});

test("streaming update details keep recent messages after final text anchor", async () => {
  const { binDir, cwd } = await setupFakePi();
  const longCommand = "0123456789".repeat(7);
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"old"}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"old result"}],"toolCallId":"old"}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"checkpoint"}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"fresh result"}],"toolCallId":"1"}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"2","arguments":{"command":"${longCommand}"}}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const updates: AgentToolResult<SubagentDetails>[] = [];
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    (update) => updates.push(update),
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const latest = updates.at(-1);
  const result = latest?.details?.results[0];
  expect((latest?.content[0] as TextContent | undefined)?.text).toBe(
    `bash: ${longCommand}`,
  );
  expect(result?.messages).toBeUndefined();
  expect(result?.termination).toBeUndefined();
  expect(result?.stderr).toBe("");
  expect(result?.progress?.toolCalls).toEqual([
    { id: "2", preview: `bash: ${longCommand}` },
  ]);
});

test("subagent keeps realtime feedback updating after a child tool error", async () => {
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"false"}}]}}'
printf '%s\n' '{"type":"tool_result_end","message":{"role":"toolResult","content":[{"type":"text","text":"failed"}],"toolCallId":"1","isError":true}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"2","arguments":{"path":"later.txt"}}]}}'
printf '%s\n' '{"type":"tool_result_end","message":{"role":"toolResult","content":[{"type":"text","text":"later result"}],"toolCallId":"2"}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"recovered"}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const updates: AgentToolResult<SubagentDetails>[] = [];
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    (update) => updates.push(update),
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const afterFailedTool = updates.find((update) =>
    update.details.results[0]?.messages?.some(
      (message) => message.role === "toolResult" && message.isError,
    ),
  );
  expect(afterFailedTool).toBeDefined();
  const afterLaterToolCall = updates.find((update) =>
    update.details.results[0]?.messages?.some((message) =>
      Array.isArray(message.content)
        ? message.content.some(
            (part) => part.type === "toolCall" && part.name === "read",
          )
        : false,
    ),
  );
  expect(afterLaterToolCall).toBeDefined();
  expect((updates.at(-1)?.content[0] as TextContent)?.text).toBe(
    "read: later.txt",
  );
});

test("subagent update content streams only final output deltas", async () => {
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0.001}}}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello world"}],"usage":{"input":2,"output":2,"totalTokens":4,"cost":{"total":0.002}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const updates: AgentToolResult<SubagentDetails>[] = [];
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    (update) => updates.push(update),
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  expect(updates.map((u) => (u.content[0] as TextContent)?.text)).toEqual([
    "(running...)",
    "(running...)",
  ]);
  expect((result.content[0] as TextContent).text).toBe("Outcome: hello world");
  expect(updates[0]?.details.results[0]?.finalOutput).toBe("Outcome: hello");
  expect(updates[0]?.details.results[0]?.usage.input).toBe(1);
  expect(updates[0]?.details.results[0]?.messages).toBeUndefined();
  expect(result.details?.results[0]?.finalOutput).toBe("Outcome: hello world");
  expect(result.details?.results[0]?.messages).toBeUndefined();
});

test("subagent updates correctly hits default running status", async () => {
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool();
  const updates: AgentToolResult<SubagentDetails>[] = [];
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    (update) => updates.push(update),
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  expect(
    updates.some((u) => (u.content[0] as TextContent)?.text === "(running...)"),
  ).toBe(true);
});

test("subagent reports depth, skill resolution, and stderr failures", async () => {
  const { agentDir, binDir, cwd } = await setupFakePi();
  const tool = getSubagentTool();
  process.env.PI_SUBAGENT_DEPTH = "1";
  await expect(
    tool.execute(
      "test-tool-call",
      { agent: "hang", task: "nested" },
      undefined,
      undefined,
      { cwd, hasUI: false } as unknown as ExtensionContext,
    ),
  ).rejects.toThrow("Subagent nesting limit reached (depth 1/1).");
  process.env.PI_SUBAGENT_DEPTH = "0";
  await writeFile(
    path.join(agentDir, "agents", "needs-skill.md"),
    `---
name: needs-skill
description: Needs a skill
skills: missing-skill
---
Prompt`,
  );
  await expect(
    tool.execute(
      "test-tool-call",
      { agent: "needs-skill", task: "skills" },
      undefined,
      undefined,
      { cwd, hasUI: false } as unknown as ExtensionContext,
    ),
  ).rejects.toThrow('Unknown skill: "missing-skill"');
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' 'boom from stderr' >&2
exit 7
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  await expect(
    tool.execute(
      "test-tool-call",
      { agent: "hang", task: "stderr" },
      undefined,
      undefined,
      { cwd, hasUI: false } as unknown as ExtensionContext,
    ),
  ).rejects.toThrow("boom from stderr");
});

test("subagent debug hygiene: child messages stay in details only for debug result", async () => {
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"SECRET_DEBUG"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"model":"gpt-4","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
printf '%s\n' 'STDERR_DEBUG' >&2
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool();
  const normalResult = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const normalDetails = normalResult.details as SubagentDetails;
  expect(normalDetails.results[0]?.messages).toBeUndefined();
  expect(normalDetails.results[0]?.termination).toBeUndefined();
  expect(normalDetails.results[0]?.stderr).toBe("");
  expect((normalResult.content[0] as TextContent).text).toBe("Outcome: hello");
  expect((normalResult.content[0] as TextContent).text).not.toContain(
    "SECRET_DEBUG",
  );
  const debugResult = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  const debugDetails = debugResult.details as SubagentDetails;
  expect(debugDetails.results[0]?.messages).toHaveLength(2);
  expect(debugDetails.results[0]?.termination?.cancelReason).toBe("agent_end");
  expect(debugDetails.results[0]?.stderr).toContain("STDERR_DEBUG");
  expect(JSON.stringify(debugDetails.results[0]?.messages)).toContain(
    "SECRET_DEBUG",
  );
  expect((debugResult.content[0] as TextContent).text).not.toContain(
    "SECRET_DEBUG",
  );
});
