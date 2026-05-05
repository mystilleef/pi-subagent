import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { TextContent } from "@mariozechner/pi-ai";
import type {
  AgentToolResult,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { SubagentDetails } from "../src/types.js";
import {
  formatTokens,
  formatToolCall,
  formatUsageStats,
  renderSubagentCall,
  renderSubagentResult,
} from "../src/ui.js";
import {
  type FakeTheme,
  getSubagentTool,
  type RegisteredMessageRenderer,
  type SendMessageArg,
  setupFakePi,
  setupHooks,
} from "./helpers.js";

setupHooks();

test("renderResult output aggregation and truncation", () => {
  const tool = getSubagentTool();
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const fakeContext = {} as unknown as ExtensionContext;
  const messages = [
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "thought 1" },
        {
          type: "toolCall" as const,
          name: "bash",
          arguments: { command: "ls -la" },
          id: "1",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "tool result" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "bash",
          arguments: { command: "ls -l" },
          id: "2",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "tool result 2" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "read",
          arguments: { path: "file1.txt" },
          id: "3",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "file contents" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "read",
          arguments: { path: "file2.txt" },
          id: "4",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "file contents 2" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "read",
          arguments: { path: "file3.txt" },
          id: "5",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "file contents 3" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "final text line 1\nfinal text line 2\nfinal text line 3\nfinal text line 4",
        },
      ],
    },
  ];
  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 0,
          stopReason: "stop",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: false, isPartial: false },
    fakeTheme as never,
    fakeContext as never,
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "[success]✓[/success] [toolTitle]*test-agent*[/toolTitle][muted] · [/muted][muted]user[/muted]",
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "[accent]read[/accent][dim] file3.txt[/dim]",
  );
  expect((rendered as unknown as { text: string }).text).not.toContain(
    "[accent]bash[/accent]",
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "[toolOutput]final text line 1[/toolOutput]",
  );
  expect((rendered as unknown as { text: string }).text).not.toContain(
    "final text line 2",
  );
});

test("renderResult expanded output", () => {
  const tool = getSubagentTool();
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const fakeContext = {} as unknown as ExtensionContext;
  const messages = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "bash",
          arguments: { command: "ls -la" },
          id: "1",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "result" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "final output line\nvery long output that would be truncated if it was collapsed",
        },
      ],
    },
  ];
  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 1,
          stopReason: "error",
          errorMessage: "some error",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: true, isPartial: false },
    fakeTheme as never,
    fakeContext as never,
  );
  const text = (rendered as unknown as { text: string }).text;
  expect(text).toContain(
    "[error]✗[/error] [toolTitle]*test-agent*[/toolTitle][muted] · [/muted][muted]user[/muted] [error][error][/error]",
  );
  expect(text).toContain("[muted]Cause:[/muted] [toolOutput]some error");
});

test("subagent updates correctly format tool calls and final text", async () => {
  const { binDir, cwd } = await setupFakePi();
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
  const messages = latest?.details?.results[0]?.messages ?? [];
  expect((latest?.content[0] as TextContent | undefined)?.text).toBe(
    `bash: ${longCommand}`,
  );
  expect(messages.map((m) => m.role)).toEqual([
    "assistant",
    "toolResult",
    "assistant",
  ]);
  expect((messages[0]?.content[0] as TextContent | undefined)?.text).toBe(
    "checkpoint",
  );
  expect(
    messages.some(
      (m) => (m.content[0] as TextContent | undefined)?.text === "old",
    ),
  ).toBe(false);
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
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const updates: AgentToolResult<SubagentDetails>[] = [];
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
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
  expect(
    (
      tool.renderResult?.(
        afterFailedTool as AgentToolResult<SubagentDetails>,
        { expanded: false, isPartial: true },
        fakeTheme as never,
        {} as never,
      ) as unknown as { text: string }
    ).text,
  ).toContain("Subagent tool result failed.");
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
  const renderedLaterToolCall = tool.renderResult?.(
    afterLaterToolCall as AgentToolResult<SubagentDetails>,
    { expanded: false, isPartial: true },
    fakeTheme as never,
    {} as never,
  ) as unknown as { text: string };
  expect(renderedLaterToolCall.text).toContain(
    '[accent]read[/accent][dim] {"path":"later.txt"}[/dim]',
  );
  expect(renderedLaterToolCall.text).not.toContain(
    "Subagent tool result failed.",
  );
  expect((updates.at(-1)?.content[0] as TextContent)?.text).toBe(
    "(running...)",
  );
});

test("renderResult subagent and unknown tools", () => {
  const tool = getSubagentTool();
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const messages = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "subagent",
          arguments: { agent: "another-agent" },
          id: "1",
        },
        {
          type: "toolCall" as const,
          name: "unknown",
          arguments: { foo: "bar" },
          id: "2",
        },
        {
          type: "toolCall" as const,
          name: "unknown_long",
          arguments: { foo: "bar".repeat(50) },
          id: "3",
        },
      ],
    },
  ];
  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 0,
          stopReason: "stop",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: false, isPartial: false },
    fakeTheme as never,
    {} as never,
  );
  expect((rendered as unknown as { text: string }).text).not.toContain(
    "[accent]subagent[/accent][dim] another-agent[/dim]",
  );
  expect((rendered as unknown as { text: string }).text).not.toContain(
    '[accent]unknown[/accent][dim] {"foo":"bar"}[/dim]',
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "[accent]unknown_long[/accent]",
  );
  expect((rendered as unknown as { text: string }).text).not.toContain("...");
});

test("renderResult expanded output truncation for > 2000 chars", () => {
  const tool = getSubagentTool();
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const messages = [
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "A".repeat(2005) }],
    },
  ];
  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 0,
          stopReason: "stop",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: true, isPartial: false },
    fakeTheme as never,
    {} as never,
  );
  const text = (rendered as unknown as { text: string }).text;
  expect(text).toBeDefined();
  expect(text).toContain("[toolOutput]AAAA");
});

test("renderCall formats tool execution correctly", () => {
  const tool = getSubagentTool();
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = tool.renderCall?.(
    {
      agent: "test-agent",
      task: "long task description that should exceed 60 characters so it gets truncated and ends up shorter",
    },
    fakeTheme as never,
    {} as never,
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "[toolTitle]*subagent *[/toolTitle][accent]test-agent[/accent][muted] [both][/muted]",
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "test-agent long task description that should exceed 60 characters so it gets truncated and ends up shorter",
  );
  const renderedShort = tool.renderCall?.(
    { agent: "...", task: "short" },
    fakeTheme as never,
    {} as never,
  );
  expect((renderedShort as unknown as { text: string }).text).toContain(
    "[accent]...[/accent]",
  );
  expect((renderedShort as unknown as { text: string }).text).toContain(
    "[dim]... short[/dim]",
  );
});

test("ui helpers format units, fallback output, and failed tool results", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(1500)).toBe("1.5k");
  expect(formatTokens(15_000)).toBe("15k");
  expect(formatTokens(1_500_000)).toBe("1.5M");
  expect(
    formatUsageStats(
      {
        turns: 2,
        input: 1500,
        output: 15_000,
        cacheRead: 999,
        cacheWrite: 1_500_000,
        cost: 0.12345,
        contextTokens: 42,
      },
      "provider/model:high",
    ),
  ).toBe(
    "2 turns · ↑1.5k ↓15k · cache:R999/W1.5M · ctx:42 · $0.1235 · provider/model:high",
  );
  expect(formatToolCall("subagent", { agent: "child" }, fakeTheme.fg)).toBe(
    "[accent]subagent[/accent][dim] child[/dim]",
  );
  const call = renderSubagentCall({}, fakeTheme) as unknown as {
    text: string;
    render: (width: number) => string[];
  };
  const callText = call.text;
  expect(callText).toContain(
    "[accent]...[/accent][muted] [both][/muted]\n  [dim]{}[/dim]",
  );
  expect(
    call
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolPendingBg]") &&
          line.endsWith("[/toolPendingBg]"),
      ),
  ).toBe(true);
  expect(
    (
      renderSubagentResult({ content: [] }, fakeTheme) as unknown as {
        text: string;
      }
    ).text,
  ).toBe("(no output)");
  const success = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "tool-success",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
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
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { text: string; render: (width: number) => string[] };
  const failed = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "tool-failure",
            agentSource: "project",
            task: "fail",
            exitCode: 0,
            messages: [{ role: "toolResult", content: [], isError: true }],
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
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { text: string; render: (width: number) => string[] };
  expect(
    success
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolSuccessBg]") &&
          line.endsWith("[/toolSuccessBg]"),
      ),
  ).toBe(true);
  expect(
    failed
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
      ),
  ).toBe(true);
  expect(failed.text).toContain("[error]✗[/error]");
  expect(failed.text).toContain("[muted](no output)[/muted]");
});

test("subagent result backgrounds cover representative success and failure cards", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const success = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput:
              "Outcome: shipped\nChanged: src/ui.ts\nVerification: bun test\nNext: none",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    name: "bash",
                    id: "tc-1",
                    arguments: { command: "bun test" },
                  },
                ],
              },
            ],
            stderr: "",
            usage: {
              input: 1000,
              output: 2000,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 0,
              turns: 1,
            },
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { text: string; render: (width: number) => string[] };
  const failure = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "breaker",
            agentSource: "user",
            task: "fail",
            exitCode: 1,
            finalOutput: "first failure line\nsecond failure line",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    name: "read",
                    id: "tc-2",
                    arguments: { path: "src/ui.ts" },
                  },
                ],
              },
            ],
            stderr: "",
            usage: {
              input: 3000,
              output: 4000,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.02,
              contextTokens: 0,
              turns: 2,
            },
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { text: string; render: (width: number) => string[] };
  expect(success.text).toContain("[success]✓[/success]");
  expect(success.text).toContain("[accent]bash[/accent][dim] bun test[/dim]");
  expect(success.text).toContain(
    "[muted]Outcome:[/muted] [toolOutput]shipped[/toolOutput]",
  );
  expect(success.text).toContain("1 turn · ↑1.0k ↓2.0k · $0.0100");
  expect(
    success
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolSuccessBg]") &&
          line.endsWith("[/toolSuccessBg]"),
      ),
  ).toBe(true);
  expect(failure.text).toContain("[error]✗[/error]");
  expect(failure.text).toContain("[accent]read[/accent][dim] src/ui.ts[/dim]");
  expect(failure.text).toContain("[toolOutput]first failure line[/toolOutput]");
  expect(failure.text).toContain("2 turns · ↑3.0k ↓4.0k · $0.0200");
  expect(
    failure
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
      ),
  ).toBe(true);
});

test("subagent result renders compact structured success output", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput:
              "Outcome: shipped\nChanged: src/ui.ts\nVerification: bun test\nNext: none",
            messages: [],
            stderr: "",
            durationMs: 1234,
            usage: {
              input: 12_000,
              output: 1_100,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.012,
              contextTokens: 38_000,
              turns: 3,
            },
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { text: string };
  expect(rendered.text).toContain("[success]✓[/success]");
  expect(rendered.text).toContain("[muted]project[/muted]");
  expect(rendered.text).toContain("[muted]1.2s[/muted]");
  expect(rendered.text).toContain(
    "[muted]Outcome:[/muted] [toolOutput]shipped[/toolOutput]",
  );
  expect(rendered.text).not.toContain("[muted]Next:[/muted]");
  expect(rendered.text).toContain("3 turns · ↑12k ↓1.1k · ctx:38k · $0.0120");
});

test("subagent result suppresses success no-op fields and keeps fallback", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const render = (finalOutput: string) =>
    renderSubagentResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: {
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: [
            {
              agent: "builder",
              agentSource: "project",
              task: "pass",
              exitCode: 0,
              finalOutput,
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
            },
          ],
        },
      },
      fakeTheme,
    ) as unknown as { text: string };
  const partial = render(
    "Outcome: shipped\nChanged: none\nVerification: bun test\nNext: n/a",
  );
  expect(partial.text).toContain(
    "[muted]Outcome:[/muted] [toolOutput]shipped[/toolOutput]",
  );
  expect(partial.text).toContain(
    "[muted]Verification:[/muted] [toolOutput]bun test[/toolOutput]",
  );
  expect(partial.text).not.toContain("[muted]Changed:[/muted]");
  expect(partial.text).not.toContain("[muted]Next:[/muted]");
  const fallback = render(
    "Outcome: none\nChanged: no changes\nVerification: not applicable\nNext: unchanged",
  );
  expect(fallback.text).toContain("[toolOutput]Outcome: none[/toolOutput]");
  expect(fallback.text).not.toContain("Changed: no changes");
});

test("subagent result parses labels and normalizes display without mutating raw output", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const longNext = "x".repeat(200);
  const rawOutput = `- outcome: **shipped across\nmultiple lines**\n**Changed:** \`src/ui.ts\`\n### Verification\n\`bun test\`\nNext: \`${longNext}\``;
  const result = {
    content: [{ type: "text", text: "raw `content`" }],
    details: {
      mode: "single",
      agentScope: "both",
      projectAgentsDir: null,
      results: [
        {
          agent: "builder",
          agentSource: "project",
          task: "pass",
          exitCode: 0,
          finalOutput: rawOutput,
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
        },
      ],
    },
  };
  const rendered = renderSubagentResult(
    result as AgentToolResult<SubagentDetails>,
    fakeTheme,
  ) as unknown as {
    text: string;
  };
  expect(rendered.text).toContain(
    "[muted]Outcome:[/muted] [toolOutput]shipped across multiple lines[/toolOutput]",
  );
  expect(rendered.text).toContain(
    "[muted]Changed:[/muted] [toolOutput]src/ui.ts[/toolOutput]",
  );
  expect(rendered.text).toContain(
    "[muted]Verification:[/muted] [toolOutput]bun test[/toolOutput]",
  );
  expect(rendered.text).toContain(
    `[muted]Next:[/muted] [toolOutput]${"x".repeat(200)}[/toolOutput]`,
  );
  expect(result.content[0]?.text).toBe("raw `content`");
  expect(result.details.results[0]?.finalOutput).toBe(rawOutput);
});

test("subagent result compacts only clear changed path lists", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const renderChanged = (changed: string) =>
    renderSubagentResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: {
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: [
            {
              agent: "builder",
              agentSource: "project",
              task: "pass",
              exitCode: 0,
              finalOutput: `Outcome: shipped\nChanged: ${changed}\nVerification: bun test\nNext: none`,
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
            },
          ],
        },
      },
      fakeTheme,
    ) as unknown as { text: string };
  const compacted = renderChanged(
    "`src/ui.ts, test/index.test.ts, src/process.ts, README.md, package.json`",
  );
  expect(compacted.text).toContain(
    "[muted]Changed:[/muted] [toolOutput]5 files: src/ui.ts, test/index.test.ts, src/process.ts, README.md, …[/toolOutput]",
  );
  expect(
    renderChanged("updated src/ui.ts, test/index.test.ts, and docs").text,
  ).toContain(
    "[muted]Changed:[/muted] [toolOutput]updated src/ui.ts, test/index.test.ts, and docs[/toolOutput]",
  );
  expect(
    renderChanged("src/ui.ts, docs only, test/index.test.ts, done, README.md")
      .text,
  ).toContain(
    "[muted]Changed:[/muted] [toolOutput]src/ui.ts, docs only, test/index.test.ts, done, README.md[/toolOutput]",
  );
  expect(renderChanged("alpha, beta, gamma, delta, epsilon").text).toContain(
    "[muted]Changed:[/muted] [toolOutput]alpha, beta, gamma, delta, epsilon[/toolOutput]",
  );
});

test("subagent result renders compact structured failure output", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "user",
            task: "fail",
            exitCode: 1,
            finalOutput:
              "Cause: compile failed\nVerification: tsc error\nNext: fix types",
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
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { text: string };
  expect(rendered.text).toContain("[error]✗[/error]");
  expect(rendered.text).toContain(
    "[muted]Cause:[/muted] [toolOutput]compile failed[/toolOutput]",
  );
  expect(rendered.text).toContain(
    "[muted]Verification:[/muted] [toolOutput]tsc error[/toolOutput]",
  );
  expect(rendered.text).not.toContain("Outcome:");
});

test("subagent result derives failure cause only when output lacks parsed cause", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const render = (finalOutput: string) =>
    renderSubagentResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: {
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: [
            {
              agent: "builder",
              agentSource: "user",
              task: "fail",
              exitCode: 1,
              errorMessage: "derived process error",
              finalOutput,
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
            },
          ],
        },
      },
      fakeTheme,
    ) as unknown as { text: string };
  const withHeadingCause = render(
    "Outcome: failed at build\n### Cause\nactual compiler error\nVerification: tsc failed\nNext: fix types",
  );
  expect(withHeadingCause.text).toContain(
    "[muted]Cause:[/muted] [toolOutput]actual compiler error[/toolOutput]",
  );
  expect(withHeadingCause.text).not.toContain("derived process error");
  expect(withHeadingCause.text).not.toContain("Outcome: failed");
  const withoutCause = render(
    "Outcome: failed at build\nVerification: tsc failed\nNext: fix types",
  );
  expect(withoutCause.text).toContain(
    "[muted]Cause:[/muted] [toolOutput]derived process error[/toolOutput]",
  );
});

test("subagent result suppresses failure no-op fields and keeps fallback", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "user",
            task: "fail",
            exitCode: 1,
            finalOutput:
              "Cause: none\nVerification: not applicable\nNext: unchanged",
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
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { text: string };
  expect(rendered.text).toContain("[toolOutput]Cause: none[/toolOutput]");
  expect(rendered.text).not.toContain("Verification: not applicable");
  expect(rendered.text).not.toContain("[muted]Cause:[/muted]");
  expect(rendered.text).not.toContain("[muted]Next:[/muted]");
});

test("subagent result falls back to first semantic output line", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "plain",
            agentSource: "user",
            task: "plain",
            exitCode: 0,
            finalOutput: "first\n\nsecond\nthird",
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
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { text: string };
  expect(rendered.text).toContain("[toolOutput]first[/toolOutput]");
  expect(rendered.text).not.toContain("second");
  expect(rendered.text).not.toContain("third");
});

test("/run final result message renderer shows header and success background", async () => {
  const { cwd } = await setupFakePi();
  const sentMessages: SendMessageArg[] = [];
  const { registeredCommands, registeredMessageRenderers } = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const renderer = registeredMessageRenderers.get("subagent-result");
  if (!renderer) throw new Error("subagent-result renderer missing");
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderer(
    sentMessages.at(-1) as Parameters<RegisteredMessageRenderer>[0],
    {} as Parameters<RegisteredMessageRenderer>[1],
    fakeTheme as Parameters<RegisteredMessageRenderer>[2],
  ) as unknown as { text: string; render: (width: number) => string[] };
  expect(rendered.text).toContain("[success]✓[/success]");
  expect(rendered.text).toContain("[toolTitle]*hang*[/toolTitle]");
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
