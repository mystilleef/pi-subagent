import { expect, test } from "bun:test";
import type {
  AgentToolResult,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  resetCapabilitiesCache,
  setCapabilities,
} from "@earendil-works/pi-tui/dist/terminal-image.js";
import { getProgressState } from "../src/progress.js";
import type { SubagentDetails } from "../src/types.js";
import {
  formatDuration,
  formatResultFooter,
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
  setupTest,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

function renderToString(component: unknown, width = 10000): string {
  if (component == null) return "";
  return (component as { render: (w: number) => string[] })
    .render(width)
    .join("\n");
}

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
  const text = renderToString(rendered);
  expect(text).toContain("[toolTitle]*test-agent*[/toolTitle]");
  expect(text).not.toContain("[toolTitle]*test-agent *[/toolTitle]");
  expect(text).not.toContain("\x1b[3m");
  expect(text).toContain("[success]✓[/success]");
  expect(text).not.toContain("[accent]");
  expect(text).toContain("[toolOutput]final text line 1[/toolOutput]");
  expect(text).toContain("[toolOutput]final text line 2[/toolOutput]");
  expect(text).toContain("[toolOutput]final text line 3[/toolOutput]");
  expect(text).toContain("[toolOutput]final text line 4[/toolOutput]");
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
  const text = renderToString(rendered);
  expect(text).toContain("[toolTitle]*test-agent*[/toolTitle]");
  expect(text).toContain("[error]✗[/error]");
  expect(text).not.toContain("[error][error][/error]");
  expect(text).toContain("[toolOutput]final output line[/toolOutput]");
});

test("result details track tool calls from subagent execution", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.toolCount).toBeGreaterThanOrEqual(1);
  const resultDetails = sentMessages.at(-1)?.details as
    | SubagentDetails
    | undefined;
  expect(resultDetails?.results[0]?.progress?.lastToolPreview).toBe("bash: ls");
});

test("result details show tool call name not final output text", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  const resultDetails = sentMessages.at(-1)?.details as
    | SubagentDetails
    | undefined;
  expect(resultDetails?.results[0]?.progress?.lastToolPreview).toBe("bash: ls");
  expect(resultDetails?.results[0]?.progress?.lastToolPreview).not.toBe(
    "final",
  );
});

test("non-debug result details expose derived progress without raw child data", async () => {
  const sentMessages: SendMessageArg[] = [];
  const longCommand = "0123456789".repeat(7);
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"old"}]}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"old result"}],"toolCallId":"old"}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"checkpoint"}]}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"fresh result"}],"toolCallId":"1"}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"2","arguments":{"command":"${longCommand}"}}]}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails | undefined;
  const result = details?.results[0];
  const json = JSON.stringify(result);
  expect(result?.messages).toBeUndefined();
  expect(result?.termination).toBeUndefined();
  expect(result?.stderr).toBe("");
  expect(result?.progress?.activityText).toBe(`bash: ${longCommand}`);
  expect(result?.progress?.lastToolPreview).toBe(`bash: ${longCommand}`);
  expect(result?.progress?.toolCalls).toEqual([
    { id: "2", preview: `bash: ${longCommand}` },
  ]);
  expect(json).not.toContain("command");
});

test("debug result details include child messages in sent result card", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"checkpoint"}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"debug-1","arguments":{"path":"safe.txt"}}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    undefined,
    { cwd, hasUI: false } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails | undefined;
  const result = details?.results[0];
  expect(result?.messages?.map((m) => m.role)).toEqual([
    "assistant",
    "assistant",
  ]);
  expect(JSON.stringify(result?.messages)).toContain("safe.txt");
});

test("renderResult with partial details after tool error does not show error icon", () => {
  const tool = getSubagentTool();
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const afterFailedTool: AgentToolResult<SubagentDetails> = {
    content: [{ type: "text" as const, text: "bash: false" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "hang",
          agentSource: "user" as const,
          task: "test",
          exitCode: 0,
          finalOutput: "",
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
          messages: [
            {
              role: "assistant" as const,
              content: [
                {
                  type: "toolCall" as const,
                  name: "bash",
                  id: "1",
                  arguments: { command: "false" },
                },
              ],
            },
            {
              role: "toolResult" as const,
              content: [{ type: "text" as const, text: "failed" }],
              toolCallId: "1",
              isError: true,
            },
          ] as never[],
        },
      ],
    },
  };
  expect(
    renderToString(
      tool.renderResult?.(
        afterFailedTool,
        { expanded: false, isPartial: true },
        fakeTheme as never,
        {} as never,
      ),
    ),
  ).toContain("[error]✗[/error]");
  const afterLaterToolCall: AgentToolResult<SubagentDetails> = {
    content: [{ type: "text" as const, text: "read: later.txt" }],
    details: {
      ...afterFailedTool.details,
      results: [
        {
          ...(afterFailedTool.details.results[0] as NonNullable<
            SubagentDetails["results"][0]
          >),
          messages: [
            ...(afterFailedTool.details.results[0]?.messages ?? []),
            {
              role: "assistant" as const,
              content: [
                {
                  type: "toolCall" as const,
                  name: "read",
                  id: "2",
                  arguments: { path: "later.txt" },
                },
              ],
            } as never,
          ],
        },
      ],
    },
  };
  const renderedLaterToolCallText = renderToString(
    tool.renderResult?.(
      afterLaterToolCall,
      { expanded: false, isPartial: true },
      fakeTheme as never,
      {} as never,
    ),
  );
  expect(renderedLaterToolCallText).not.toContain("[accent]read[/accent]");
  expect(renderedLaterToolCallText).not.toContain(
    "Subagent tool result failed.",
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
  const renderedText = renderToString(rendered);
  expect(renderedText).not.toContain("[accent]subagent[/accent]");
  expect(renderedText).not.toContain("[accent]unknown[/accent]");
  expect(renderedText).not.toContain("[accent]unknown_long[/accent]");
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
  const text = renderToString(rendered);
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
  expect(formatDuration(850)).toBe("850ms");
  expect(formatDuration(1234)).toBe("1.2s");
  expect(formatDuration(65000)).toBe("1m 05s");
  expect(
    formatResultFooter(
      {
        turns: 3,
        input: 12_000,
        output: 1100,
        cacheRead: 999,
        cacheWrite: 1500,
        cost: 0.012,
        contextTokens: 38_000,
      },
      "provider/model:high",
      1234,
    ),
  ).toBe("\nprovider/model:high · ctx:38k · 3 turns · 1.2s · $0.0120");
  expect(
    formatResultFooter(
      {
        turns: 0,
        input: 12_000,
        output: 1100,
        cacheRead: 999,
        cacheWrite: 1500,
        cost: 0,
        contextTokens: 0,
      },
      undefined,
      0,
    ),
  ).toBe("\n0ms");
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
  expect(
    formatToolCall(
      "unknown",
      { token: "secret", password: "hidden", nested: { value: "leak" } },
      fakeTheme.fg,
    ),
  ).toBe("[accent]unknown[/accent]");
  expect(
    formatToolCall("unknown", { token: "secret" }, fakeTheme.fg, true),
  ).toBe('[accent]unknown[/accent][dim] {"token":"secret"}[/dim]');
  expect(formatToolCall("bash", { command: "bun test" }, fakeTheme.fg)).toBe(
    "[accent]bash[/accent][dim] bun test[/dim]",
  );
  expect(
    formatToolCall("bash", { command: "printf 'a'\n\t  echo b" }, fakeTheme.fg),
  ).toBe("[accent]bash[/accent][dim] printf 'a' echo b[/dim]");
  expect(formatToolCall("bash", { command: "\n\t  " }, fakeTheme.fg)).toBe(
    "[accent]bash[/accent]",
  );
  expect(
    formatToolCall(
      "subagent",
      { agent: "child", task: "line one\n\t  line two" },
      fakeTheme.fg,
    ),
  ).toBe("[accent]subagent[/accent][dim] child line one line two[/dim]");
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
  ) as unknown as { render: (width: number) => string[] };
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
  ) as unknown as { render: (width: number) => string[] };
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
  const failedText = renderToString(failed);
  expect(failedText).toContain("[error]✗[/error]");
  expect(failedText).toContain("[muted](no output)[/muted]");
});

test("subagent result markdown invokes theme callbacks", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const markdown = `# Heading\n\n[docs](https://example.com) and \`inline\`\n\n\`\`\`ts\nconst x = 1\n\`\`\`\n\n> quoted **bold** and *italic* and ~~gone~~\n\n---\n\n- item`;
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
            instanceName: "able-falcon",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput: markdown,
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
  );
  const renderedText = renderToString(rendered);
  resetCapabilitiesCache();
  expect(renderedText).toContain(
    "[toolTitle]*builder*[/toolTitle] [accent]\x1b[3mable-falcon\x1b[23m[/accent]",
  );
  expect(renderedText.indexOf("\x1b[23m[/accent]")).toBeLessThan(
    renderedText.indexOf("[mdHeading]"),
  );
  expect(renderedText).toContain("[mdHeading]");
  expect(renderedText).toContain("[mdLink]");
  expect(renderedText).toContain(
    "[mdLinkUrl] (https://example.com)[/mdLinkUrl]",
  );
  expect(renderedText).toContain("[mdCode]inline[/mdCode]");
  expect(renderedText).toContain(
    "[mdCodeBlockBorder]```ts[/mdCodeBlockBorder]",
  );
  expect(renderedText).toContain("[mdCodeBlock]const x = 1[/mdCodeBlock]");
  expect(renderedText).toContain("[mdQuoteBorder]│ [/mdQuoteBorder]");
  expect(renderedText).toContain("[mdQuote]");
  expect(renderedText).toContain("[mdHr]");
  expect(renderedText).toContain("[mdListBullet]- [/mdListBullet]");
  expect(renderedText).toContain("\x1b[3mitalic\x1b[23m");
  expect(renderedText).toContain("\x1b[9mgone\x1b[29m");
  expect(renderedText).toContain("\x1b[4m");
});

test("subagent-result message renderer uses summarized content and preserves result chrome", () => {
  const tool = getSubagentTool();
  const renderer = tool.registeredMessageRenderers.get("subagent-result");
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "runner",
        agentSource: "project",
        task: "pass",
        exitCode: 0,
        finalOutput: "raw child output must stay hidden from run card",
        messages: [],
        stderr: "",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.01,
          contextTokens: 0,
          turns: 1,
        },
      },
    ],
  };
  if (!renderer) throw new Error("subagent-result renderer missing");
  const rendered = renderer(
    {
      role: "custom",
      customType: "subagent-result",
      content: "summarized semantic outcome",
      display: true,
      timestamp: 0,
      details,
    },
    { expanded: false },
    fakeTheme as never,
  ) as unknown as { render: (width: number) => string[] };
  const lines = rendered.render(120);
  const text = lines.join("\n");
  expect(text).toContain("[toolOutput]summarized semantic outcome");
  expect(text).toContain("[/toolOutput]");
  expect(text).not.toContain("raw child output must stay hidden from run card");
  expect(text).toContain("[toolSuccessBg] 1 turn · $0.0100[/dim]");
  expect(
    lines.every(
      (line) =>
        line.startsWith("[toolSuccessBg]") && line.endsWith("[/toolSuccessBg]"),
    ),
  ).toBe(true);
  expect(details.results[0]?.finalOutput).toBe(
    "raw child output must stay hidden from run card",
  );
});

test("normal subagent tool rendering continues to use raw final output", () => {
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "formatted parent content" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "tool",
            instanceName: "clear-marten",
            agentSource: "user",
            task: "pass",
            exitCode: 0,
            finalOutput: "raw final output remains body",
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
  ) as unknown as { render: (width: number) => string[] };
  const text = renderToString(rendered);
  expect(text).toContain(
    "[toolTitle]*tool*[/toolTitle] [accent]\x1b[3mclear-marten\x1b[23m[/accent]",
  );
  expect(text).not.toContain("[toolTitle]*tool clear-marten*[/toolTitle]");
  expect(text).toContain(
    "[toolOutput]raw final output remains body[/toolOutput]",
  );
  expect(text).not.toContain("formatted parent content");
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
  ) as unknown as { render: (width: number) => string[] };
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
  ) as unknown as { render: (width: number) => string[] };
  const successText = renderToString(success);
  expect(successText).toContain("[success]✓[/success]");
  expect(successText).not.toContain("[accent]bash[/accent]");
  expect(successText).not.toContain("Outcome: shipped");
  expect(successText).toContain("1 turn · $0.0100");
  expect(successText).not.toContain("↑1.0k");
  expect(successText).not.toContain("↓2.0k");
  expect(
    success
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolSuccessBg]") &&
          line.endsWith("[/toolSuccessBg]"),
      ),
  ).toBe(true);
  const failureText = renderToString(failure);
  expect(failureText).toContain("[error]✗[/error]");
  expect(failureText).not.toContain("[accent]read[/accent]");
  expect(failureText).toContain("[toolOutput]first failure line[/toolOutput]");
  expect(failureText).toContain("2 turns · $0.0200");
  expect(failureText).not.toContain("↑3.0k");
  expect(failureText).not.toContain("↓4.0k");
  expect(
    failure
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
      ),
  ).toBe(true);
});

test("subagent result renders cancelled result with appropriate icon and error background", () => {
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
            agent: "runner",
            agentSource: "user",
            task: "abort",
            exitCode: 0,
            stopReason: "aborted",
            finalOutput: "was doing work",
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
  ) as unknown as { render: (width: number) => string[] };
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[error]⊘[/error]");
  expect(renderedText).not.toContain("[success]✓[/success]");
  expect(renderedText).toContain("[toolTitle]*runner*[/toolTitle]");
  expect(renderedText).toContain("[toolOutput]was doing work[/toolOutput]");
  expect(
    rendered
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolErrorBg]") &&
          line.endsWith("[/toolErrorBg]"),
      ),
  ).toBe(true);
});

test("subagent result renders outcome-only output instead of no output", () => {
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
            finalOutput: "Outcome: shipped",
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
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]Outcome: shipped[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
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
            model: "provider/model:high",
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
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[success]✓[/success]");
  expect(renderedText).toContain("[toolTitle]*builder*[/toolTitle]");
  expect(renderedText).not.toContain("[muted]1.2s[/muted]");
  expect(renderedText).not.toContain("Outcome: shipped");
  expect(renderedText).toContain("[toolOutput]Changed: src/ui.ts[/toolOutput]");
  expect(renderedText).toContain(
    "provider/model:high · ctx:38k · 3 turns · 1.2s · $0.0120",
  );
  expect(renderedText).not.toContain("↑12k");
  expect(renderedText).not.toContain("↓1.1k");
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
  const partialText = renderToString(
    render(
      "Outcome: shipped\nChanged: none\nVerification: bun test\nNext: n/a",
    ),
  );
  expect(partialText).not.toContain("Outcome: shipped");
  expect(partialText).toContain("[toolOutput]Changed: none[/toolOutput]");
  expect(partialText).toContain(
    "[toolOutput]Verification: bun test[/toolOutput]",
  );
  expect(partialText).not.toContain("[muted]Outcome:[/muted]");
  const fallbackText = renderToString(
    render(
      "Outcome: none\nChanged: no changes\nVerification: not applicable\nNext: unchanged",
    ),
  );
  expect(fallbackText).not.toContain("Outcome: none");
  expect(fallbackText).toContain(
    "[toolOutput]Changed: no changes[/toolOutput]",
  );
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
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("outcome");
  expect(renderedText).toContain("shipped");
  expect(renderedText).toContain("src/ui.ts");
  expect(renderedText).not.toContain("[muted]Outcome:[/muted]");
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
  const compactedText = renderToString(
    renderChanged(
      "`src/ui.ts, test/index.test.ts, src/process.ts, README.md, package.json`",
    ),
  );
  expect(compactedText).toContain("Changed:");
  expect(compactedText).toContain("src/ui.ts");
  expect(compactedText).not.toContain("[muted]Changed:[/muted]");
  expect(
    renderToString(
      renderChanged("updated src/ui.ts, test/index.test.ts, and docs"),
    ),
  ).toContain("Changed: updated src/ui.ts");
  expect(
    renderToString(renderChanged("alpha, beta, gamma, delta, epsilon")),
  ).toContain("Changed: alpha, beta, gamma, delta, epsilon");
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
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[error]✗[/error]");
  expect(renderedText).toContain(
    "[toolOutput]Cause: compile failed[/toolOutput]",
  );
  expect(renderedText).toContain(
    "[toolOutput]Verification: tsc error[/toolOutput]",
  );
  expect(renderedText).toContain("[toolOutput]Next: fix types[/toolOutput]");
  expect(renderedText).not.toContain("[muted]Cause:[/muted]");
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
  const withHeadingCauseText = renderToString(
    render(
      "Outcome: failed at build\n### Cause\nactual compiler error\nVerification: tsc failed\nNext: fix types",
    ),
  );
  expect(withHeadingCauseText).toContain("[error]✗[/error]");
  expect(withHeadingCauseText).not.toContain("Outcome: failed at build");
  const withoutCauseText = renderToString(
    render(
      "Outcome: failed at build\nVerification: tsc failed\nNext: fix types",
    ),
  );
  expect(withoutCauseText).toContain("[error]✗[/error]");
  expect(withoutCauseText).not.toContain("Outcome: failed at build");
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
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]Cause: none[/toolOutput]");
  expect(renderedText).toContain(
    "[toolOutput]Verification: not applicable[/toolOutput]",
  );
  expect(renderedText).toContain("[toolOutput]Next: unchanged[/toolOutput]");
  expect(renderedText).not.toContain("[muted]Cause:[/muted]");
});

test("subagent result preserves raw output lines in UI", () => {
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
            finalOutput:
              "hello\nsorry about that\nerror: details\nfirst\n\nsecond\nthird",
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
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]hello[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]sorry about that[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]error: details[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]first[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]second[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]third[/toolOutput]");
});

test("subagent-result renderer uses compact content instead of full final output", () => {
  const { registeredMessageRenderers } = getSubagentTool();
  const renderer = registeredMessageRenderers.get("subagent-result");
  if (!renderer) throw new Error("subagent-result renderer missing");
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "plain",
        agentSource: "user",
        task: "plain",
        exitCode: 0,
        finalOutput: "# Full result\n\nParagraph one.\n\nParagraph two.",
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
  };
  const originalDetails = structuredClone(details);
  const rendered = renderer(
    {
      role: "assistant",
      customType: "subagent-result",
      content: [{ type: "text", text: "Compact parent summary." }],
      details,
    } as unknown as Parameters<RegisteredMessageRenderer>[0],
    {} as Parameters<RegisteredMessageRenderer>[1],
    fakeTheme as Parameters<RegisteredMessageRenderer>[2],
  );
  const renderedText = renderToString(rendered, 40);
  expect(renderedText).toContain("Compact parent");
  expect(renderedText).toContain("summary.");
  expect(renderedText).not.toContain("Full result");
  expect(renderedText).not.toContain("Paragraph one.");
  expect(renderedText).not.toContain("Paragraph two.");
  expect(details).toEqual(originalDetails);
});

test("/run final result message renderer hides header and keeps success background", async () => {
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
  ) as unknown as { render: (width: number) => string[] };
  const renderedText = rendered.render(10000).join("\n");
  expect(renderedText).not.toContain("[success]✓[/success]");
  expect(renderedText).not.toContain("[toolTitle]*hang*[/toolTitle]");
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
