import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  resetCapabilitiesCache,
  setCapabilities,
} from "@earendil-works/pi-tui/dist/terminal-image.js";
import * as usageLedger from "../src/orchestration/usage-ledger.js";
import { renderRunsBoard } from "../src/output/runs-board.js";
import {
  createDescendantTally,
  formatResultFooter,
  formatSubagentTitle,
  formatTokens,
  getFinalOutput,
  renderSubagentCall,
  renderSubagentResult,
  withLayoutGap,
} from "../src/output/ui.js";
import type { SubagentProgressState } from "../src/progress/progress.js";
import { getProgressState } from "../src/progress/progress.js";
import {
  createProgressState,
  getAllProgressStates,
} from "../src/progress/progress-state.js";
import type {
  SubagentDetails,
  UsageInstanceNode,
} from "../src/shared/types.js";
import {
  createDefaultFakeTheme,
  emitAgentEnd,
  getSubagentTool,
  makeBareCtx,
  makeMessageRenderOptions,
  makeSingleResult,
  makeSubagentToolUpdateLine,
  type RegisteredMessageRenderer,
  requestIdOf,
  runTool,
  type SendMessageArg,
  setupHooks,
  setupTest,
  shellQuote,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

function renderToString(component: unknown, width = 10000): string {
  if (component == null) return "";
  return (component as { render: (w: number) => string[] })
    .render(width)
    .join("\n");
}

describe("withLayoutGap", () => {
  test("renders zero lines when the inner block renders nothing", () => {
    const gap = withLayoutGap({ render: () => [], invalidate: () => {} });
    expect(gap.render(80)).toEqual([]);
  });

  test("prepends exactly one blank row before a present block", () => {
    const gap = withLayoutGap({
      render: (width: number) => [`width:${width}`],
      invalidate: () => {},
    });
    expect(gap.render(80)).toEqual(["", "width:80"]);
  });

  test("forwards invalidate to the inner component", () => {
    let invalidated = 0;
    const gap = withLayoutGap({
      render: () => [],
      invalidate: () => {
        invalidated += 1;
      },
    });
    gap.invalidate();
    gap.invalidate();
    expect(invalidated).toBe(2);
  });
});

test("descendant tally invalidate is a no-op", () => {
  const theme = createDefaultFakeTheme();
  const tally = createDescendantTally(
    {
      id: "tally-root",
      agent: "root",
      instanceName: "top",
      ordinal: 1,
      startedAt: 1000,
      status: "success",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        turns: 0,
      },
      children: [
        {
          id: "tally-child",
          agent: "build",
          instanceName: "one",
          ordinal: 1,
          startedAt: 2000,
          status: "success",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.02,
            turns: 0,
          },
          children: [],
        },
      ],
    },
    theme,
  );
  expect(tally).toBeDefined();
  expect(tally?.render(120).length).toBeGreaterThan(0);
  expect(() => tally?.invalidate()).not.toThrow();
});

test("renderResult output aggregation and truncation", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
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
          finalOutput:
            "final text line 1\nfinal text line 2\nfinal text line 3\nfinal text line 4",
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

test("renderResult suppresses direct nested result when message rendered it", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
  const fakeContext = {} as unknown as ExtensionContext;
  const rendered = tool.renderResult?.(
    {
      content: [{ type: "text" as const, text: "done" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        renderedByMessage: true as const,
        results: [
          makeSingleResult({
            agent: "nested-agent",
            agentSource: "user",
            task: "nested",
            finalOutput: "done",
          }),
        ],
      },
    } as AgentToolResult<SubagentDetails>,
    { expanded: false, isPartial: false },
    fakeTheme as never,
    fakeContext as never,
  );
  const text = renderToString(rendered);
  expect(text).toBe("");
  expect(text).not.toContain("nested-agent");
  expect(text).not.toContain("done");
  expect(text).not.toContain("[success]");
});

test("renderResult expanded output", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
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
          finalOutput:
            "final output line\nvery long output that would be truncated if it was collapsed",
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
${emitAgentEnd()}
exit 0
`,
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = requestIdOf(sentMessages);
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
${emitAgentEnd()}
exit 0
`,
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
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
${emitAgentEnd()}
exit 0
`,
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
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
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"checkpoint"}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"debug-1","arguments":{"path":"safe.txt"}}]}}'
${emitAgentEnd()}
exit 0
`,
  });
  await runTool(
    tool,
    { agent: "hang", task: "test", debug: true },
    makeBareCtx(cwd),
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
  const fakeTheme = createDefaultFakeTheme();
  const afterFailedTool: AgentToolResult<SubagentDetails> = {
    content: [{ type: "text" as const, text: "bash: false" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        makeSingleResult({
          agent: "hang",
          agentSource: "user",
          task: "test",
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
        }),
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
  const fakeTheme = createDefaultFakeTheme();
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
  const fakeTheme = createDefaultFakeTheme();
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
          finalOutput: "A".repeat(2005),
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
  const fakeTheme = createDefaultFakeTheme();
  const rendered = tool.renderCall?.(
    {
      agent: "test-agent",
      task: "long task description that should exceed 60 characters so it gets truncated and ends up shorter",
    },
    fakeTheme as never,
    {} as never,
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "[toolTitle]*subagent *[/toolTitle][toolTitle]*test-agent*[/toolTitle][muted] [both][/muted]",
  );
  // Parser-owned preview suppresses task text: only shows [scope] when agent present
  expect((rendered as unknown as { text: string }).text).not.toContain(
    "long task description that should exceed 60 characters",
  );
  // Supplied agent: single line, no duplicate detail line.
  expect((rendered as unknown as { text: string }).text).not.toContain(
    "[dim][both][/dim]",
  );
  expect((rendered as unknown as { text: string }).text).not.toContain("\n");
  const renderedShort = tool.renderCall?.(
    { agent: "...", task: "short" },
    fakeTheme as never,
    {} as never,
  );
  expect((renderedShort as unknown as { text: string }).text).toContain(
    "[toolTitle]*...*[/toolTitle]",
  );
  // Task text suppressed: single line, no detail line.
  expect((renderedShort as unknown as { text: string }).text).not.toContain(
    "short",
  );
  expect((renderedShort as unknown as { text: string }).text).not.toContain(
    "[dim][both][/dim]",
  );
  expect((renderedShort as unknown as { text: string }).text).not.toContain(
    "\n",
  );
});

test("renderSubagentCall simplifies supplied-agent headers to a single line", () => {
  const fakeTheme = createDefaultFakeTheme();
  const getText = (component: unknown) => (component as { text: string }).text;
  const getLines = (component: unknown, width = 120) =>
    (component as { render: (w: number) => string[] }).render(width);
  const assertPendingBackground = (component: unknown) => {
    expect(
      getLines(component).every(
        (line) =>
          line.startsWith("[toolPendingBg]") &&
          line.endsWith("[/toolPendingBg]"),
      ),
    ).toBe(true);
  };
  // Default scope.
  const def = renderSubagentCall(
    { agent: "helper", task: "do work" },
    fakeTheme,
  );
  expect(getText(def)).toBe(
    "[toolTitle]*subagent *[/toolTitle][toolTitle]*helper*[/toolTitle][muted] [both][/muted]",
  );
  expect(getText(def)).not.toContain("do work");
  expect(getText(def)).not.toContain("\n");
  assertPendingBackground(def);
  // Explicit scopes stay single-line with muted scope.
  for (const scope of ["both", "user", "project"] as const) {
    const supplied = renderSubagentCall(
      { agent: "helper", task: "ignored", agentScope: scope },
      fakeTheme,
    );
    expect(getText(supplied)).toBe(
      `[toolTitle]*subagent *[/toolTitle][toolTitle]*helper*[/toolTitle][muted] [${scope}][/muted]`,
    );
    expect(getText(supplied)).not.toContain("ignored");
    expect(getText(supplied)).not.toContain("\n");
    assertPendingBackground(supplied);
  }
  // Unnamed preserves fallback plus raw-argument detail line.
  const unnamed = renderSubagentCall({}, fakeTheme);
  expect(getText(unnamed)).toContain(
    "[accent]...[/accent][muted] [both][/muted]\n  [dim]{}[/dim]",
  );
  assertPendingBackground(unnamed);
  // Host renderer integration matches direct rendering.
  const tool = getSubagentTool();
  const viaHost = tool.renderCall?.(
    { agent: "helper", task: "do work" },
    fakeTheme as never,
    {} as never,
  );
  expect(getText(viaHost)).toBe(getText(def));
});

test("renderSubagentResult formats units, fallback output, and failed tool results", () => {
  const fakeTheme = createDefaultFakeTheme();
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(1500)).toBe("1.5k");
  expect(formatTokens(15_000)).toBe("15k");
  expect(formatTokens(1_500_000)).toBe("1.5M");
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
    ),
  ).toBe("provider/model:high · 3 turns · $0.0120");
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
    ),
  ).toBe("");
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
          makeSingleResult({
            agent: "tool-success",
            task: "pass",
            finalOutput: "done",
            messages: [],
          }),
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
            agentSource: "project",
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
            agent: "tool-failure",
            task: "fail",
            messages: [{ role: "toolResult", content: [], isError: true }],
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

test("subagent result keeps subagent call chrome unchanged", () => {
  const fakeTheme = createDefaultFakeTheme();
  const call = renderSubagentCall({}, fakeTheme) as unknown as {
    text: string;
    render: (width: number) => string[];
  };
  // Parser-owned preview: no agent → falls back to JSON.stringify(args)
  expect(call.text).toContain(
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
});
test("subagent result markdown invokes theme callbacks", () => {
  const fakeTheme = createDefaultFakeTheme();
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
          makeSingleResult({
            agent: "builder",
            instanceName: "able-falcon",
            task: "pass",
            finalOutput: markdown,
            messages: [],
          }),
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  resetCapabilitiesCache();
  expect(renderedText).toContain(
    "[toolTitle]*builder*[/toolTitle] [accent]_able-falcon_[/accent]",
  );
  expect(renderedText.indexOf("_[/accent]")).toBeLessThan(
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
  expect(renderedText).toContain("_italic_");
  expect(renderedText).toContain("~gone~");
  expect(renderedText).toContain("__");
});

test("subagent-result message renderer uses summarized content and preserves result chrome", () => {
  const tool = getSubagentTool();
  const renderer = tool.registeredMessageRenderers.get("subagent-result");
  const fakeTheme = createDefaultFakeTheme();
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      makeSingleResult({
        agent: "runner",
        task: "pass",
        finalOutput: "raw child output must stay hidden from run card",
        messages: [],
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.01,
          contextTokens: 0,
          turns: 1,
        },
      }),
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
    makeMessageRenderOptions(),
    fakeTheme as never,
  ) as unknown as { render: (width: number) => string[] };
  const lines = rendered.render(120);
  const text = lines.join("\n");
  expect(text).toContain("[toolOutput]summarized semantic outcome");
  expect(text).toContain("[/toolOutput]");
  expect(text).not.toContain("raw child output must stay hidden from run card");
  expect(text).toContain("[dim]1 turn · $0.0100[/dim]");
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

test("subagent-result renderer falls back to details output for non-text content", () => {
  const renderer =
    getSubagentTool().registeredMessageRenderers.get("subagent-result");
  if (!renderer) throw new Error("subagent-result renderer missing");
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [makeSingleResult({ finalOutput: "details output" })],
  };
  const rendered = renderer(
    {
      role: "custom",
      customType: "subagent-result",
      content: { unexpected: true } as never,
      display: true,
      timestamp: 0,
      details,
    },
    makeMessageRenderOptions(),
    createDefaultFakeTheme() as never,
  ) as unknown as { render: (width: number) => string[] };
  expect(rendered.render(120).join("\n")).toContain("details output");
});

test("normal subagent tool rendering continues to use raw final output", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "formatted parent content" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "tool",
            instanceName: "clear-marten",
            agentSource: "user",
            task: "pass",
            finalOutput: "raw final output remains body",
            messages: [],
          }),
        ],
      },
    },
    fakeTheme,
  ) as unknown as { render: (width: number) => string[] };
  const text = renderToString(rendered);
  expect(text).toContain(
    "[toolTitle]*tool*[/toolTitle] [accent]_clear-marten_[/accent]",
  );
  expect(text).not.toContain("[toolTitle]*tool clear-marten*[/toolTitle]");
  expect(text).toContain(
    "[toolOutput]raw final output remains body[/toolOutput]",
  );
  expect(text).not.toContain("formatted parent content");
});

test("subagent result backgrounds cover representative success and failure cards", () => {
  const fakeTheme = createDefaultFakeTheme();
  const success = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agentSource: "project",
            exitCode: 0,
            stderr: "",
            agent: "builder",
            task: "pass",
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
            stderr: "",
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
  expect(successText).toContain("Outcome: shipped");
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
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "runner",
            agentSource: "user",
            task: "abort",
            stopReason: "aborted",
            finalOutput: "was doing work",
            messages: [],
          }),
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
          line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
      ),
  ).toBe(true);
});

test("subagent result renders outcome-only output instead of no output", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "Outcome: shipped",
            messages: [],
          }),
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
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput:
              "Outcome: shipped\nChanged: src/ui.ts\nVerification: bun test\nNext: none",
            messages: [],
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
          }),
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[success]✓[/success]");
  expect(renderedText).toContain("[toolTitle]*builder*[/toolTitle]");
  expect(renderedText).not.toContain("[muted]1.2s[/muted]");
  expect(renderedText).toContain("Outcome: shipped");
  expect(renderedText).toContain("[toolOutput]Changed: src/ui.ts[/toolOutput]");
  expect(renderedText).toContain("provider/model:high · 3 turns · $0.0120");
  expect(renderedText).not.toContain("ctx:");
  expect(renderedText).not.toContain("↑12k");
  expect(renderedText).not.toContain("↓1.1k");
});

test("subagent result suppresses success no-op fields and keeps fallback", () => {
  const fakeTheme = createDefaultFakeTheme();
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
  expect(partialText).toContain("Outcome: shipped");
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
  expect(fallbackText).toContain("Outcome: none");
  expect(fallbackText).toContain(
    "[toolOutput]Changed: no changes[/toolOutput]",
  );
});

test("subagent result parses labels and normalizes display without mutating raw output", () => {
  const fakeTheme = createDefaultFakeTheme();
  const longNext = "x".repeat(200);
  const rawOutput = `- outcome: **shipped across\nmultiple lines**\n**Changed:** \`src/ui.ts\`\n### Verification\n\`bun test\`\nNext: \`${longNext}\``;
  const result = {
    content: [{ type: "text", text: "raw `content`" }],
    details: {
      mode: "single",
      agentScope: "both",
      projectAgentsDir: null,
      results: [
        makeSingleResult({
          agent: "builder",
          task: "pass",
          finalOutput: rawOutput,
          messages: [],
        }),
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
  const fakeTheme = createDefaultFakeTheme();
  const renderChanged = (changed: string) =>
    renderSubagentResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: {
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: [
            makeSingleResult({
              agent: "builder",
              task: "pass",
              finalOutput: `Outcome: shipped\nChanged: ${changed}\nVerification: bun test\nNext: none`,
              messages: [],
            }),
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
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            agentSource: "user",
            task: "fail",
            exitCode: 1,
            finalOutput:
              "Cause: compile failed\nVerification: tsc error\nNext: fix types",
            messages: [],
          }),
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
  const fakeTheme = createDefaultFakeTheme();
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
  expect(withHeadingCauseText).toContain("Outcome: failed at build");
  const withoutCauseText = renderToString(
    render(
      "Outcome: failed at build\nVerification: tsc failed\nNext: fix types",
    ),
  );
  expect(withoutCauseText).toContain("[error]✗[/error]");
  expect(withoutCauseText).toContain("Outcome: failed at build");
});

test("subagent result suppresses failure no-op fields and keeps fallback", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            agentSource: "user",
            task: "fail",
            exitCode: 1,
            finalOutput:
              "Cause: none\nVerification: not applicable\nNext: unchanged",
            messages: [],
          }),
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
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "plain",
            agentSource: "user",
            task: "plain",
            finalOutput:
              "hello\nsorry about that\nerror: details\nfirst\n\nsecond\nthird",
            messages: [],
          }),
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
  const fakeTheme = createDefaultFakeTheme();
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      makeSingleResult({
        agent: "plain",
        agentSource: "user",
        task: "plain",
        finalOutput: "# Full result\n\nParagraph one.\n\nParagraph two.",
        messages: [],
      }),
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

test("formatResultFooter excludes duration from output", () => {
  const footer = formatResultFooter(
    {
      turns: 5,
      input: 10000,
      output: 2000,
      cacheRead: 500,
      cacheWrite: 1000,
      cost: 0.05,
      contextTokens: 50000,
      contextWindowTokens: 200000,
    },
    "test-model",
  );
  expect(footer).toBe("test-model · 5 turns · $0.0500");
  expect(footer).not.toContain("ctx:");
  expect(footer).not.toMatch(/\d+(\.\d+)?(ms|s|m \d+s)/);
});

describe("unconfirmed thinking UI footer propagation", () => {
  function renderResultModel(result: { model?: string; finalOutput?: string }) {
    const fakeTheme = createDefaultFakeTheme();
    const rendered = renderSubagentResult(
      {
        content: [{ type: "text" as const, text: "ignored" }],
        details: {
          mode: "single" as const,
          agentScope: "both" as const,
          projectAgentsDir: null,
          results: [
            makeSingleResult({
              agentSource: "user",
              finalOutput: result.finalOutput ?? "done",
              model: result.model,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 1,
              },
              messages: [],
            }),
          ],
        },
      },
      fakeTheme,
    ) as unknown as { render: (width: number) => string[] };
    return rendered.render(120).join("\n");
  }

  test.each([
    {
      name: "renderSubagentResult footer includes requested unconfirmed level",
      model: "unknown ･ unknown ･ high",
      expectedText: "[dim]unknown ･ unknown ･ high · 1 turn[/dim]",
    },
    {
      name: "renderSubagentResult footer shows confirmed requested level",
      model: "custom ･ reasoner ･ medium",
      expectedText: "[dim]custom ･ reasoner ･ medium · 1 turn[/dim]",
    },
  ])("$name", (row) => {
    const text = renderResultModel({
      model: row.model,
    });
    expect(text).toContain(row.expectedText);
  });

  test("renderSubagentResult footer omits model when absent", () => {
    const text = renderResultModel({});
    expect(text).toContain("[dim]1 turn[/dim]");
    expect(text).not.toContain("unknown");
  });
});

test("renderSubagentResult includes metadata in header with tools, context, and elapsed time", () => {
  const fakeTheme = createDefaultFakeTheme();
  const result = renderSubagentResult(
    {
      content: [{ type: "text", text: "test" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "project",
            task: "test task",
            exitCode: 0,
            stderr: "",
            finalOutput: "done",
            usage: {
              input: 10000,
              output: 2000,
              cacheRead: 500,
              cacheWrite: 1000,
              cost: 0.05,
              contextTokens: 150000,
              contextWindowTokens: 200000,
              turns: 5,
            },
            model: "test-model",
            durationMs: 45200,
            progress: {
              toolCalls: [
                { name: "read", id: "1", args: {} },
                { name: "write", id: "2", args: {} },
                { name: "bash", id: "3", args: {} },
              ],
            },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(result);
  expect(text).toMatch(/\d+ tools? · \d+% ctx · \d+(\.\d+)?(ms|s|m \d+s)/);
  expect(text).toContain("3 tools");
  expect(text).toContain("75% ctx");
  expect(text).toContain("45.2s");
});

test("renderSubagentResult metadata handles undefined toolCalls", () => {
  const fakeTheme = createDefaultFakeTheme();
  const result = renderSubagentResult(
    {
      content: [{ type: "text", text: "test" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            finalOutput: "done",
            usage: {
              input: 1000,
              output: 500,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 5000,
              contextWindowTokens: 200000,
              turns: 1,
            },
            durationMs: 1500,
            messages: [],
          }),
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(result);
  expect(text).toContain("0 tools");
  expect(text).toMatch(/0 tools · \d+% ctx · \d+(\.\d+)?(ms|s|m \d+s)/);
});

test("renderSubagentResult metadata handles undefined contextWindowTokens", () => {
  const fakeTheme = createDefaultFakeTheme();
  const result = renderSubagentResult(
    {
      content: [{ type: "text", text: "test" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "project",
            task: "test task",
            exitCode: 0,
            stderr: "",
            finalOutput: "done",
            usage: {
              input: 1000,
              output: 500,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 5000,
              turns: 1,
            },
            durationMs: 2000,
            progress: {
              toolCalls: [{ name: "read", id: "1", args: {} }],
            },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(result);
  expect(text).toContain("--% ctx");
  expect(text).toMatch(/\d+ tools? · --% ctx · \d+(\.\d+)?(ms|s|m \d+s)/);
});

test("renderSubagentResult metadata handles undefined durationMs", () => {
  const fakeTheme = createDefaultFakeTheme();
  const result = renderSubagentResult(
    {
      content: [{ type: "text", text: "test" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "project",
            task: "test task",
            exitCode: 0,
            stderr: "",
            finalOutput: "done",
            usage: {
              input: 1000,
              output: 500,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 5000,
              contextWindowTokens: 200000,
              turns: 1,
            },
            progress: {
              toolCalls: [{ name: "read", id: "1", args: {} }],
            },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(result);
  expect(text).toContain("0.0s");
  expect(text).toMatch(/\d+ tools? · \d+% ctx · 0\.0s/);
});

test("renderRunsBoard renders empty board", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("No /run jobs in this session.");
  expect(text).toContain("[muted]");
});

test("renderRunsBoard starts nonempty board with session summary", () => {
  usageLedger.resetUsageLedger();
  createProgressState("session-zero", "agent", "task", "inst");
  const usage = {
    session: usageLedger.querySessionUsage(),
    instances: new Map(),
  };
  const text = renderToString(
    renderRunsBoard(
      getAllProgressStates(),
      createDefaultFakeTheme() as never,
      80,
      usage,
    ),
  );
  const lines = text.split("\n");
  expect(lines[0]).toStartWith(
    "[muted]*Session*[/muted][muted] · 0 runs · 0 instances · $0.0000[/muted]",
  );
  expect(text.indexOf("Session")).toBeLessThan(text.indexOf("ACTIVE (1)"));
});

test("job card omits run cost for root-only ledger entries", () => {
  usageLedger.resetUsageLedger();
  createProgressState("cost-single", "build", "task", "inst");
  const registered = usageLedger.registerRootInstance({
    id: "cost-single",
    agent: "build",
    instanceName: "inst",
    startedAt: 500,
  });
  expect(registered.ok).toBe(true);
  const held = usageLedger.queryInstanceUsage("cost-single");
  if (!held) throw new Error("expected ledger instance");
  const usage = {
    session: usageLedger.querySessionUsage(),
    instances: new Map([["cost-single", held.instance]]),
  };
  const theme = createDefaultFakeTheme();
  const board = renderToString(
    renderRunsBoard(getAllProgressStates(), theme as never, 80, usage),
  );
  expect(board).not.toContain("run $");
  expect(board).toContain("inst");
});

test("renderRunsBoard renders status sections in fixed order", () => {
  const now = Date.now();
  const states: SubagentProgressState[] = [
    {
      requestId: "r1",
      agent: "builder",
      instanceName: "able-falcon",
      taskPreview: "build stuff",
      status: "success",
      startTime: now - 300000,
      durationMs: 280000,
      toolCount: 5,
      contextTokens: 20000,
      contextWindowTokens: 50000,
      finalOutput: "Built all the things successfully",
    },
    {
      requestId: "r2",
      agent: "reviewer",
      taskPreview: "review code",
      status: "running",
      startTime: now - 60000,
      toolCount: 2,
      contextTokens: 8000,
      contextWindowTokens: 50000,
      lastToolPreview: "read: src/ui.ts",
    },
    {
      requestId: "r3",
      agent: "test-runner",
      taskPreview: "run tests",
      status: "error",
      startTime: now - 200000,
      durationMs: 150000,
      toolCount: 3,
      contextTokens: 12000,
      contextWindowTokens: 50000,
      errorText: "bun test failed with exit code 1",
    },
    {
      requestId: "r4",
      agent: "scanner",
      taskPreview: "scan files",
      status: "cancelled",
      startTime: now - 100000,
      durationMs: 5000,
      toolCount: 1,
      finalOutput: "scanning...",
      errorText: "Cancelled by user",
    },
  ];
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard(states, fakeTheme as never, 32);
  const text = renderToString(rendered);
  const lines = text.split("\n");
  expect(lines).toBeArray();
  expect(text).toContain(
    "[muted]*ACTIVE (1)*[/muted] [dim]─────────────────────[/dim]",
  );
  expect(text).toContain(
    "[muted]*FAILED (1)*[/muted] [dim]─────────────────────[/dim]",
  );
  expect(text).toContain(
    "[muted]*CANCELLED (1)*[/muted] [dim]──────────────────[/dim]",
  );
  expect(text).toContain(
    "[muted]*SUCCEEDED (1)*[/muted] [dim]──────────────────[/dim]",
  );
  expect(text).not.toContain("ACTIVE (0)");
  expect(text).not.toContain("COMPLETED");
  expect(text.indexOf("ACTIVE (1)")).toBeLessThan(text.indexOf("FAILED (1)"));
  expect(text.indexOf("FAILED (1)")).toBeLessThan(
    text.indexOf("CANCELLED (1)"),
  );
  expect(text.indexOf("CANCELLED (1)")).toBeLessThan(
    text.indexOf("SUCCEEDED (1)"),
  );
  const headerLines = lines.filter(
    (l) =>
      l.includes("[running]") ||
      l.includes("[success]") ||
      l.includes("[error]") ||
      l.includes("[cancelled]"),
  );
  expect(headerLines).toHaveLength(4);
  expect(headerLines[0]).toStartWith("[toolPendingBg]");
  expect(headerLines[1]).toStartWith("[toolErrorBg]");
  expect(headerLines[2]).toStartWith("[toolErrorBg]");
  expect(headerLines[3]).toStartWith("[toolSuccessBg]");
  expect(
    headerLines.every((line) =>
      /\[\/tool(?:Pending|Error|Success)Bg\]$/.test(line),
    ),
  ).toBe(true);
  const cardLines = lines.filter((line) =>
    /^\[tool(?:Pending|Error|Success)Bg\]/.test(line),
  );
  expect(cardLines).toHaveLength(20);
  expect(
    cardLines.every((line) =>
      /^\[tool(?:Pending|Error|Success)Bg\].*\[\/tool(?:Pending|Error|Success)Bg\]$/.test(
        line,
      ),
    ),
  ).toBe(true);
  expect(headerLines[0]).toContain(
    "[accent]⟳[/accent] [toolTitle]*reviewer*[/toolTitle] [muted][running][/muted] [dim]2 tools · 16% ctx ·",
  );
  expect(headerLines[1]).toContain(
    "[error]✗[/error] [toolTitle]*test-runner*[/toolTitle] [muted][error][/muted] [dim]3 tools · 24% ctx · 2m 30s[/dim]",
  );
  expect(headerLines[2]).toContain(
    "[error]⊘[/error] [toolTitle]*scanner*[/toolTitle] [muted][cancelled][/muted] [dim]1 tool · --% ctx · 5.0s[/dim]",
  );
  expect(headerLines[3]).toContain(
    "[success]✓[/success] [toolTitle]*builder*[/toolTitle] [accent]_able-falcon_[/accent] [muted][success][/muted] [dim]5 tools · 40% ctx · 4m 40s[/dim]",
  );
  expect(text).toContain(
    "[toolSuccessBg]   [toolOutput]Built all the things successfully[/toolOutput]",
  );
  expect(text).toContain(
    "[toolErrorBg]   [toolOutput]bun test failed with exit code 1[/toolOutput]",
  );
  expect(text).toContain(
    "[toolErrorBg]   [toolOutput]scanning...[/toolOutput]",
  );
});

test("renderRunsBoard omits empty status sections", () => {
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: Date.now() - 10000,
    toolCount: 1,
    finalOutput: "working",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("ACTIVE (1)");
  expect(text).not.toContain("FAILED (0)");
  expect(text).not.toContain("CANCELLED (0)");
  expect(text).not.toContain("SUCCEEDED (0)");
  expect(text).not.toContain("COMPLETED");
});

test("renderRunsBoard truncates body preview after 120 chars", () => {
  const exactOutput = "A".repeat(120);
  const longOutput = "B".repeat(121);
  const states: SubagentProgressState[] = [
    {
      requestId: "r1",
      agent: "builder",
      taskPreview: "do work",
      status: "success",
      startTime: Date.now() - 10000,
      durationMs: 5000,
      toolCount: 1,
      finalOutput: exactOutput,
    },
    {
      requestId: "r2",
      agent: "reviewer",
      taskPreview: "review work",
      status: "success",
      startTime: Date.now() - 9000,
      durationMs: 4000,
      toolCount: 1,
      finalOutput: longOutput,
    },
  ];
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard(states, fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain(exactOutput);
  expect(text).toContain(`${longOutput.slice(0, 119)}…`);
  expect(text).not.toContain(longOutput);
});

test("renderRunsBoard uses body source priority and fallback", () => {
  const now = Date.now();
  const states: SubagentProgressState[] = [
    {
      requestId: "r1",
      agent: "builder",
      taskPreview: "task preview",
      status: "error",
      startTime: now - 10000,
      durationMs: 5000,
      toolCount: 1,
      finalOutput: "final output",
      errorText: "error text",
    },
    {
      requestId: "r2",
      agent: "reviewer",
      taskPreview: "fallback preview",
      status: "error",
      startTime: now - 9000,
      durationMs: 4000,
      toolCount: 1,
      finalOutput: " ",
      errorText: "error only",
    },
    {
      requestId: "r3",
      agent: "planner",
      taskPreview: "preview only",
      status: "running",
      startTime: now - 8000,
      toolCount: 1,
      finalOutput: "",
      errorText: "",
    },
    {
      requestId: "r4",
      agent: "empty",
      taskPreview: "",
      status: "success",
      startTime: now - 7000,
      durationMs: 3000,
      toolCount: 1,
      finalOutput: "",
      errorText: " ",
    },
  ];
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard(states, fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]final output[/toolOutput]");
  expect(text).not.toContain("[toolOutput]error text[/toolOutput]");
  expect(text).toContain("[toolOutput]error only[/toolOutput]");
  expect(text).toContain("[toolOutput]preview only[/toolOutput]");
  expect(text).toContain("[muted](no output)[/muted]");
});

test("abridged status cards without footer keep existing line output", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "",
    status: "running",
    startTime: now - 10000,
    toolCount: 0,
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const lines = text.split("\n");
  const cardLines = lines.filter((line) =>
    /^\[tool(Pending|Error|Success)Bg\]/.test(line),
  );
  expect(cardLines).toHaveLength(5);
  expect(text).toContain("[muted](no output)[/muted]");
});

test("abridged progress job card with modelDisplay renders dim model footer", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 3,
    contextTokens: 10000,
    contextWindowTokens: 50000,
    modelDisplay: "provider/model:high",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[dim]provider/model:high[/dim]");
});

test("abridged progress job card with modelDisplay excludes usage/cost/turn/context footer segments", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 4,
    contextTokens: 5000,
    contextWindowTokens: 200000,
    modelDisplay: "provider/model:high",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const footerLine = text
    .split("\n")
    .find((l) => l.includes("[dim]") && l.includes("provider/model:high"));
  expect(footerLine).toBeDefined();
  expect(footerLine).not.toContain("turn");
  expect(footerLine).not.toContain("ctx:");
  expect(footerLine).not.toContain("$");
  expect(footerLine).not.toContain("↑");
  expect(footerLine).not.toContain("↓");
});

test("abridged progress job card with modelDisplay and zero tool count preserves compact body", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "empty-tool",
    taskPreview: "",
    status: "running",
    startTime: now - 10000,
    toolCount: 0,
    modelDisplay: "provider/model:fast",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[dim]provider/model:fast[/dim]");
  expect(text).toContain("[muted](no output)[/muted]");
});

test("abridged progress job card with modelDisplay and long body preview truncates and preserves footer", () => {
  const now = Date.now();
  const longBody = "X".repeat(200);
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "verbose",
    taskPreview: "",
    status: "running",
    startTime: now - 10000,
    toolCount: 1,
    finalOutput: longBody,
    modelDisplay: "provider/model:verbose",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain(`${longBody.slice(0, 119)}…`);
  expect(text).not.toContain(longBody);
  expect(text).toContain("[dim]provider/model:verbose[/dim]");
});

test("abridged progress job card without modelDisplay renders no dim model footer", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 2,
    contextTokens: 5000,
    contextWindowTokens: 50000,
    finalOutput: "working on it",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const dimParts = text.match(/\[dim\]([^[]+)\[\/dim\]/g) ?? [];
  const modelFooter = dimParts.filter((p) => p.includes("model"));
  expect(modelFooter).toHaveLength(0);
});

test("abridged progress job card with undefined modelDisplay excludes footer", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "",
    status: "running",
    startTime: now - 10000,
    toolCount: 0,
    modelDisplay: undefined,
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[muted](no output)[/muted]");
  const dimParts = text.match(/\[dim\]([^[]+)\[\/dim\]/g) ?? [];
  const modelFooter = dimParts.filter((p) => p.includes("model"));
  expect(modelFooter).toHaveLength(0);
});

test("progress model footer regression: exact footer line is dim model only", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 3,
    contextTokens: 10000,
    contextWindowTokens: 50000,
    modelDisplay: "provider/model:high",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const lines = text.split("\n");
  const footerLines = lines.filter(
    (l) => l.includes("[dim]") && l.includes("provider/model:high"),
  );
  expect(footerLines).toHaveLength(1);
  const fl0 = footerLines[0] as string;
  expect(fl0.trim()).toMatch(
    /^\[toolPendingBg\] \[dim\]provider\/model:high\[\/dim\]\s+\[\/toolPendingBg\]$/,
  );
});

test("progress model footer regression: footer line rejects all completed-card segments", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 60000,
    toolCount: 5,
    inputTokens: 12000,
    outputTokens: 8000,
    contextTokens: 50000,
    contextWindowTokens: 200000,
    modelDisplay: "provider/model:high",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const lines = text.split("\n");
  const footerLine = lines.find(
    (l) => l.includes("[dim]") && l.includes("provider/model:high"),
  );
  expect(footerLine).toBeDefined();
  const fl = footerLine as string;
  expect(fl).toContain("[dim]provider/model:high[/dim]");
  expect(fl).not.toContain("turn");
  expect(fl).not.toContain("ctx:");
  expect(fl).not.toContain("$");
  expect(fl).not.toContain("↑");
  expect(fl).not.toContain("↓");
  expect(fl).not.toMatch(/\d+s\b/);
  expect(fl).not.toMatch(/\dm \d+s/);
  expect(fl).not.toMatch(/\dtools?\b/);
});

test("progress model footer regression: empty string modelDisplay excludes footer", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 1,
    modelDisplay: "",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const dimFooters = (text.match(/\[muted\][^[]*\[\/muted\]/g) ?? []).filter(
    (m) => m.includes("model"),
  );
  expect(dimFooters).toHaveLength(0);
});

test("progress model footer regression: footer exclusive to modelDisplay-bearing cards in mixed board", () => {
  const now = Date.now();
  const states: SubagentProgressState[] = [
    {
      requestId: "r1",
      agent: "builder",
      taskPreview: "build",
      status: "running",
      startTime: now - 10000,
      toolCount: 3,
      contextTokens: 10000,
      contextWindowTokens: 50000,
      modelDisplay: "provider/model:high",
      finalOutput: "building...",
    },
    {
      requestId: "r2",
      agent: "reviewer",
      taskPreview: "review",
      status: "running",
      startTime: now - 5000,
      toolCount: 1,
      contextTokens: 5000,
      contextWindowTokens: 50000,
      finalOutput: "reviewing...",
    },
    {
      requestId: "r3",
      agent: "tester",
      taskPreview: "test",
      status: "error",
      startTime: now - 20000,
      durationMs: 15000,
      toolCount: 2,
      modelDisplay: undefined,
      errorText: "tests failed",
    },
    {
      requestId: "r4",
      agent: "scanner",
      taskPreview: "scan",
      status: "running",
      startTime: now - 30000,
      toolCount: 0,
      modelDisplay: "provider/model:fast",
      finalOutput: " ",
    },
  ];
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard(states, fakeTheme as never);
  const text = renderToString(rendered);
  const dimModelFooters = (
    text.match(/\[dim\](provider\/model[^[]+)\[\/dim\]/g) ?? []
  ).map((m) => m.replace("[dim]", "").replace("[/dim]", ""));
  expect(dimModelFooters).toHaveLength(2);
  expect(dimModelFooters).toContain("provider/model:high");
  expect(dimModelFooters).toContain("provider/model:fast");
});

test("full status card footer still renders after abridged footer support", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "done",
            messages: [],
            model: "provider/model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 0,
              turns: 1,
            },
          }),
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[dim]provider/model · 1 turn · $0.0100[/dim]");
});

test("empty footer text does not render a blank footer line on status card", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "done",
            messages: [],
          }),
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  const lines = text.split("\n");
  const cardLines = lines.filter((line) =>
    /^\[tool(?:Pending|Error|Success)Bg\]/.test(line),
  );
  expect(cardLines).toHaveLength(5);
});

test("result detail shape compatible with preserved nested activity progress", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading config.ts"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: completed"}],"usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.01}}}}'
${emitAgentEnd()}
exit 0
`,
  });
  await runTool(
    tool,
    { agent: "hang", task: "shape compat" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(resultDetails.results[0]).toBeDefined();
  expect(resultDetails.results[0]?.exitCode).toBe(0);
  expect(resultDetails.results[0]?.usage).toBeDefined();
  expect(resultDetails.results[0]?.progress).toBeDefined();
  expect(Array.isArray(resultDetails.results[0]?.progress?.toolCalls)).toBe(
    true,
  );
});

test("sanitized result details preserve progress tool calls without internal fields", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Scanning dependencies"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"tc-read","arguments":{"path":"package.json"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":5,"output":10,"totalTokens":15,"cost":{"total":0.005}}}}'
${emitAgentEnd()}
exit 0
`,
  });
  await runTool(
    tool,
    { agent: "hang", task: "sanitized progress" },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  const progress = resultDetails.results[0]?.progress;
  expect(progress).toBeDefined();
  expect(progress?.toolCalls).toBeDefined();
  expect(progress?.toolCalls.length).toBeGreaterThanOrEqual(1);
  expect(progress?.toolCalls[0]?.id).toBe("tc-read");
  expect(progress?.toolCalls[0]?.preview).toBe("read: package.json");
});

test("renderResult isPartial=true uses content[0].text when finalOutput is empty", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "bash: ls" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
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
            agentSource: "user",
            task: "test",
            progress: {
              activityText: "running bash: ls",
              lastToolPreview: "bash: ls",
            },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]bash: ls[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=true falls back to activityText when content[0].text is absent", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
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
            agentSource: "user",
            task: "test",
            progress: { activityText: "reading file" },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]reading file[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=true falls back to activityText when content[0].text is empty string", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
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
            agentSource: "user",
            task: "test",
            progress: { activityText: "reading file" },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]reading file[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=true falls back to lastToolPreview when activityText is absent", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
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
            agentSource: "user",
            task: "test",
            progress: { lastToolPreview: "read: config.ts" },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]read: config.ts[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=true falls back to (running...) when all sources are empty", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agentSource: "user",
            task: "test",
            messages: [],
          }),
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput](running...)[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=false keeps using finalOutput as body", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "bash: ls" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agentSource: "user",
            task: "test",
            finalOutput: "final result text",
            messages: [],
          }),
        ],
      },
    },
    fakeTheme,
    { isPartial: false },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]final result text[/toolOutput]");
  expect(renderedText).not.toContain("bash: ls");
});

test("renderResult isPartial=true with non-empty finalOutput still uses finalOutput", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "bash: ls" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agentSource: "user",
            task: "test",
            finalOutput: "final result text",
            messages: [],
          }),
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]final result text[/toolOutput]");
  expect(renderedText).not.toContain("bash: ls");
});

test("formatResultFooter outputs model only when all usage fields are zero", () => {
  const footer = formatResultFooter(
    {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
    },
    "provider/model",
  );
  expect(footer).toBe("provider/model");
  expect(footer).not.toContain(" · ");
});

test.each([
  {
    name: "formatResultFooter with model and turns only suppresses context and cost when zero",
    turns: 3,
    cost: 0,
    contextTokens: 0,
    expectedFooter: "provider/model · 3 turns",
    absentFragmentA: "ctx",
    absentFragmentB: "$",
  },
  {
    name: "formatResultFooter with model and contextTokens only omits context and keeps model",
    turns: 0,
    cost: 0,
    contextTokens: 38000,
    expectedFooter: "provider/model",
    absentFragmentA: "turn",
    absentFragmentB: "$",
  },
  {
    name: "formatResultFooter with model and cost only suppresses turns and context when zero",
    turns: 0,
    cost: 0.01,
    contextTokens: 0,
    expectedFooter: "provider/model · $0.0100",
    absentFragmentA: "turn",
    absentFragmentB: "ctx",
  },
])("$name", (row) => {
  const footer = formatResultFooter(
    {
      turns: row.turns,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: row.cost,
      contextTokens: row.contextTokens,
    },
    "provider/model",
  );
  expect(footer).toBe(row.expectedFooter);
  expect(footer).not.toContain(row.absentFragmentA);
  expect(footer).not.toContain(row.absentFragmentB);
});

test("formatResultFooter without model but with usage fields keeps correct order", () => {
  const footer = formatResultFooter(
    {
      turns: 2,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.02,
      contextTokens: 50000,
    },
    undefined,
  );
  expect(footer).toBe("2 turns · $0.0200");
  expect(footer).not.toContain("model");
  expect(footer).not.toContain("ctx:");
});

test("completed result card footer renders model, turns, cost in fixed order", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "done",
            messages: [],
            model: "claude-sonnet-4-20250514",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.005,
              contextTokens: 12400,
              turns: 3,
            },
          }),
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  const footerIdx = renderedText.indexOf("[dim]claude-sonnet-4-20250514");
  expect(footerIdx).toBeGreaterThan(0);
  const afterFooter = renderedText.slice(footerIdx);
  const modelIdx = afterFooter.indexOf("claude-sonnet-4-20250514");
  const turnsIdx = afterFooter.indexOf("3 turns");
  const costIdx = afterFooter.indexOf("$0.0050");
  expect(modelIdx).toBeGreaterThanOrEqual(0);
  expect(turnsIdx).toBeGreaterThan(0);
  expect(costIdx).toBeGreaterThan(turnsIdx);
  expect(afterFooter).not.toContain("ctx:");
  expect(afterFooter).not.toContain("↑");
  expect(afterFooter).not.toContain("↓");
  expect(afterFooter).not.toMatch(/\d+(ms|s|m \d+s)/);
});

test("completed result card footer excludes token arrow metrics", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "done",
            messages: [],
            model: "provider/model",
            usage: {
              input: 5000,
              output: 2500,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 10000,
              turns: 2,
            },
          }),
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("provider/model · 2 turns · $0.0100");
  expect(renderedText).not.toContain("ctx:");
  expect(renderedText).not.toContain("↑5.0k");
  expect(renderedText).not.toContain("↓2.5k");
});

test("completed result card footer suppresses model segment when model is undefined", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "done",
            messages: [],
            model: undefined,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 0,
              turns: 1,
            },
          }),
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[dim]1 turn · $0.0100[/dim]");
  expect(renderedText).not.toContain("[muted]undefined[/muted]");
});

test("completed result card footer suppresses context segment when contextTokens is zero", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "done",
            messages: [],
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 1,
            },
          }),
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[dim]test-model · 1 turn[/dim]");
  expect(renderedText).not.toMatch(/\[dim\]test-model · 1 turn · ctx/);
  expect(renderedText).not.toMatch(/\[dim\]test-model · 1 turn · \$/);
});

test("completed result card footer suppresses cost segment when cost is zero", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "done",
            messages: [],
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 10000,
              turns: 1,
            },
          }),
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[dim]test-model · 1 turn[/dim]");
  expect(renderedText).not.toContain("ctx:");
  expect(renderedText).not.toContain("$");
});

test.each<{
  status: SubagentProgressState["status"];
  fields: Partial<SubagentProgressState>;
  expected: string[];
}>([
  {
    status: "error",
    fields: {
      taskPreview: "build failed",
      toolCount: 2,
      errorText: "build collapsed",
      modelDisplay: "provider/model:err",
    },
    expected: ["[dim]provider/model:err[/dim]", "FAILED", "build collapsed"],
  },
  {
    status: "cancelled",
    fields: {
      taskPreview: "cancelled task",
      toolCount: 1,
      modelDisplay: "provider/model:cancel",
    },
    expected: ["[dim]provider/model:cancel[/dim]", "CANCELLED"],
  },
  {
    status: "success",
    fields: {
      taskPreview: "passed tests",
      toolCount: 3,
      finalOutput: "all tests pass",
      modelDisplay: "provider/model:ok",
    },
    expected: ["[dim]provider/model:ok[/dim]", "SUCCEEDED", "all tests pass"],
  },
])(
  "abridged job card renders modelDisplay footer for $status state",
  ({ status, fields, expected }) => {
    const state: SubagentProgressState = {
      requestId: "r1",
      agent: "builder",
      taskPreview: "",
      status,
      startTime: Date.now() - 30000,
      durationMs: 25000,
      toolCount: 0,
      ...fields,
    };
    const text = renderToString(
      renderRunsBoard([state], createDefaultFakeTheme() as never),
    );
    for (const fragment of expected) {
      expect(text).toContain(fragment);
    }
  },
);

test("abridged job card with modelDisplay uses errorText as body when finalOutput is empty", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "error",
    startTime: now - 30000,
    durationMs: 25000,
    toolCount: 1,
    errorText: "specific error message",
    finalOutput: "",
    modelDisplay: "provider/model",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]specific error message[/toolOutput]");
  expect(text).toContain("[dim]provider/model[/dim]");
});

test("abridged job card with modelDisplay falls back body from taskPreview when no finalOutput or errorText", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "fallback preview text",
    status: "running",
    startTime: now - 30000,
    toolCount: 1,
    modelDisplay: "provider/model",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("fallback preview text");
  expect(text).not.toContain("(no output)");
});

test("abridged job card with modelDisplay shows (no output) when all body sources are empty", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "",
    status: "running",
    startTime: now - 30000,
    toolCount: 0,
    modelDisplay: "provider/model",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[muted](no output)[/muted]");
});

test("completed result card footer is empty when model and usage all missing", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "done",
            messages: [],
            model: undefined,
          }),
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  const lines = renderedText.split("\n");
  const cardLines = lines.filter((line) =>
    /^\[tool(?:Pending|Error|Success)Bg\]/.test(line),
  );
  expect(cardLines).toHaveLength(5);
  expect(renderedText).toContain("[dim]0 tools");
});

test("renderSubagentResult shows finalOutput only from assistant text and performs no hidden outcome synthesis", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "pure assistant text here",
            outcome: "should-not-be-synthesized-into-body",
            messages: [],
          }),
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("pure assistant text here");
  expect(renderedText).not.toContain("should-not-be-synthesized-into-body");
});

test("getFinalOutput returns last assistant text and tolerates non-array content", () => {
  const fakeTheme = createDefaultFakeTheme();
  expect(getFinalOutput([])).toBe("");
  const stringContent = [
    { role: "assistant", content: "plain string" },
  ] as unknown as Message[];
  expect(getFinalOutput(stringContent)).toBe("");
  const toolOnly = [
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: {}, id: "1" }],
    },
  ] as unknown as Message[];
  expect(getFinalOutput(toolOnly)).toBe("");
  const textMessages = [
    { role: "user", content: [{ type: "text", text: "user" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "toolCall", name: "bash", arguments: {}, id: "1" },
        { type: "text", text: "last" },
      ],
    },
  ] as unknown as Message[];
  expect(getFinalOutput(textMessages)).toBe("last");
  const fallbackResult = renderSubagentResult(
    {
      content: [{ type: "text", text: "subagent text" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "fallback",
            task: "task",
            messages: textMessages,
          }),
        ],
      },
    },
    fakeTheme,
  ) as unknown as { render: (width: number) => string[] };
  const fallbackText = renderToString(fallbackResult);
  expect(fallbackText).toContain("[muted](no output)[/muted]");
  expect(fallbackText).not.toContain("last");
});

test("completed result card renders from finalOutput and ignores stale messages", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agentSource: "project",
            exitCode: 0,
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
            agent: "builder",
            task: "pass",
            finalOutput: "preserved final output",
            messages: [
              {
                role: "assistant" as const,
                content: [
                  { type: "text" as const, text: "stale message output" },
                ],
              },
            ],
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]preserved final output[/toolOutput]");
  expect(text).not.toContain("stale message output");
});

test("completed result card shows (no output) when finalOutput is blank even with messages", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agentSource: "project",
            exitCode: 0,
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
            agent: "builder",
            task: "pass",
            finalOutput: "   ",
            messages: [
              {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "message text" }],
              },
            ],
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[muted](no output)[/muted]");
  expect(text).not.toContain("message text");
});

test("completed result card renders sanitized details without messages from finalOutput", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          makeSingleResult({
            agent: "builder",
            task: "pass",
            finalOutput: "sanitized final output",
          }),
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]sanitized final output[/toolOutput]");
});

test("partial result card still prefers finalOutput over live content", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "live content text" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agentSource: "project",
            exitCode: 0,
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
            agent: "builder",
            task: "pass",
            finalOutput: "existing final output",
            progress: { activityText: "running activity" },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]existing final output[/toolOutput]");
  expect(text).not.toContain("live content text");
  expect(text).not.toContain("running activity");
});

describe("ordinal-aware titles", () => {
  function makeTreeWithOrdinal(ordinal: number): UsageInstanceNode {
    return {
      id: "r-tree",
      agent: "build",
      instanceName: "brave-otter",
      ordinal,
      startedAt: 1,
      status: "success",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      children: [],
    };
  }
  test("inserts #ordinal for ordinal >=2 preserving existing segments", () => {
    const theme = createDefaultFakeTheme();
    expect(formatSubagentTitle("build", "brave-otter", theme, 3)).toContain(
      "#3",
    );
    expect(formatSubagentTitle("build", "brave-otter", theme, 3)).toContain(
      "brave-otter",
    );
    expect(formatSubagentTitle("build", "brave-otter", theme, 3)).toContain(
      "build",
    );
  });
  test("preserves legacy formatting for ordinal 1 or missing", () => {
    const theme = createDefaultFakeTheme();
    const legacy = formatSubagentTitle("build", "brave-otter", theme);
    expect(formatSubagentTitle("build", "brave-otter", theme, 1)).toBe(legacy);
    expect(formatSubagentTitle("build", "brave-otter", theme, undefined)).toBe(
      legacy,
    );
    expect(formatSubagentTitle("build", "brave-otter", theme, 1.5)).toBe(
      legacy,
    );
  });
  test("result card shows #ordinal only for repeated instances", () => {
    const theme = createDefaultFakeTheme();
    const repeated = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: {
            mode: "single",
            agentScope: "both",
            projectAgentsDir: null,
            results: [
              makeSingleResult({
                agent: "build",
                instanceName: "brave-otter",
                ordinal: 2,
                finalOutput: "done",
              }),
            ],
          },
        },
        theme,
      ),
    );
    expect(repeated).toContain("#2");
    const first = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: {
            mode: "single",
            agentScope: "both",
            projectAgentsDir: null,
            results: [
              makeSingleResult({
                agent: "build",
                instanceName: "brave-otter",
                ordinal: 1,
                finalOutput: "done",
              }),
            ],
          },
        },
        theme,
      ),
    );
    expect(first).not.toContain("#1");
    expect(first).toContain("brave-otter");
  });
  test("result card falls back to usageTree ordinal for persisted details", () => {
    const theme = createDefaultFakeTheme();
    const rendered = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: {
            mode: "single",
            agentScope: "both",
            projectAgentsDir: null,
            results: [
              makeSingleResult({
                agent: "build",
                instanceName: "brave-otter",
                finalOutput: "done",
              }),
            ],
            usageTree: {
              id: "r1",
              agent: "build",
              instanceName: "brave-otter",
              ordinal: 4,
              startedAt: 1,
              status: "success",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                turns: 0,
              },
              children: [],
            },
          },
        },
        theme,
      ),
    );
    expect(rendered).toContain("#4");
  });
  test("result card ignores non-integer result ordinal and uses tree ordinal", () => {
    const theme = createDefaultFakeTheme();
    const tree = makeTreeWithOrdinal(3);
    const rendered = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: {
            mode: "single",
            agentScope: "both",
            projectAgentsDir: null,
            results: [
              makeSingleResult({
                agent: "build",
                instanceName: "brave-otter",
                ordinal: 1.5,
                finalOutput: "done",
              }),
            ],
            usageTree: tree,
          },
        },
        theme,
      ),
    );
    expect(rendered).toContain("#3");
  });
  test("result card prefers result ordinal over tree ordinal", () => {
    const theme = createDefaultFakeTheme();
    const rendered = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: {
            mode: "single",
            agentScope: "both",
            projectAgentsDir: null,
            results: [
              makeSingleResult({
                agent: "build",
                instanceName: "brave-otter",
                ordinal: 4,
                finalOutput: "done",
              }),
            ],
            usageTree: makeTreeWithOrdinal(3),
          },
        },
        theme,
      ),
    );
    expect(rendered).toContain("#4");
    expect(rendered).not.toContain("#3");
  });
});

describe("persisted result accounting", () => {
  function persistedTree(): UsageInstanceNode {
    return {
      id: "root-1",
      agent: "build",
      instanceName: "brave-otter",
      ordinal: 2,
      startedAt: 1000,
      status: "success",
      durationMs: 1200,
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        turns: 1,
      },
      children: [
        {
          id: "child-1",
          agent: "fix",
          instanceName: "quick-fox",
          ordinal: 1,
          startedAt: 1100,
          status: "success",
          durationMs: 300,
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.02,
            turns: 1,
          },
          children: [],
        },
        {
          id: "child-2",
          agent: "fix",
          instanceName: "slow-bear",
          ordinal: 1,
          startedAt: 1200,
          status: "error",
          durationMs: 400,
          usage: {
            input: 20,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.03,
            turns: 2,
          },
          children: [],
        },
      ],
      omitted: {
        count: 1,
        totals: {
          instances: 1,
          statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
          usage: {
            input: 5,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.04,
            turns: 1,
          },
          durationMs: 100,
          byAgent: {
            plan: {
              instances: 1,
              statuses: { running: 0, success: 1, error: 0, cancelled: 0 },
              usage: {
                input: 5,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.04,
                turns: 1,
              },
              durationMs: 100,
            },
          },
        },
      },
    };
  }

  function persistedDetails(
    overrides: Partial<ReturnType<typeof makeSingleResult>> = {},
  ): SubagentDetails {
    return {
      mode: "single",
      agentScope: "both",
      projectAgentsDir: null,
      results: [
        makeSingleResult({
          agent: "build",
          instanceName: "brave-otter",
          ordinal: 2,
          finalOutput: "persisted body",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.005,
            contextTokens: 12400,
            turns: 3,
          },
          ...overrides,
        }),
      ],
      usageTree: persistedTree(),
    };
  }

  test("places descendant tally below body with descendant-inclusive run cost", () => {
    const theme = createDefaultFakeTheme();
    const text = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: persistedDetails(),
        },
        theme,
      ),
    );
    expect(text).toContain("3 spawned");
    expect(text).toContain("run $0.1000");
    const lines = text.split("\n");
    const headerIdx = lines.findIndex((line) => line.includes("brave-otter"));
    const tallyIdx = lines.findIndex((line) => line.includes("3 spawned"));
    const bodyIdx = lines.findIndex((line) => line.includes("persisted body"));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(headerIdx);
    expect(tallyIdx).toBeGreaterThan(bodyIdx);
    const footerIdx = lines.findIndex((line) => line.includes("$0.0050"));
    expect(footerIdx).toBeGreaterThan(tallyIdx);
    const tallyLine = lines[tallyIdx] ?? "";
    expect(tallyLine).toContain("run $0.1000");
    expect(tallyLine).toContain("\u2713");
    const footerLine = lines.find((l) => l.includes("$0.0050")) ?? "";
    expect(footerLine).not.toContain("run $");
    expect(footerLine).toContain("$0.0050");
    expect(footerLine).not.toContain("ctx:");
  });

  test("keeps self footer distinct from subtree run cost while preserving body and metadata", () => {
    const theme = createDefaultFakeTheme();
    const text = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: persistedDetails(),
        },
        theme,
      ),
    );
    expect(text).toContain("test-model");
    expect(text).toContain("3 turns");
    expect(text).toContain("$0.0050");
    expect(text).toContain("run $0.1000");
    expect(text).toContain("persisted body");
    expect(text).toContain("tools");
    expect(text).toContain("ctx");
    const tallyLine =
      text.split("\n").find((l) => l.includes("3 spawned")) ?? "";
    expect(tallyLine).toContain("run $0.1000");
    expect(tallyLine).toContain("\u2713");
    const footerLine =
      text.split("\n").find((l) => l.includes("$0.0050")) ?? "";
    expect(footerLine).toContain("$0.0050");
    expect(footerLine).not.toContain("run $");
  });

  test("renders run cost footer alone when result usage footer is empty", () => {
    const theme = createDefaultFakeTheme();
    const details = persistedDetails({
      model: undefined,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    });
    const text = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details,
        },
        theme,
      ),
    );
    expect(text).toContain("3 spawned");
    const tallyLine = text
      .split("\n")
      .find((line) => line.includes("3 spawned")) as string;
    expect(tallyLine).toContain("run $0.1000");
    expect(text).not.toMatch(/\n.*run \$0\.1000.*\n.*persisted body/);
  });

  test("renders identical output after ledger reset for persisted details", () => {
    const theme = createDefaultFakeTheme();
    const payload = {
      content: [{ type: "text" as const, text: "ignored" }],
      details: persistedDetails(),
    };
    const before = renderToString(renderSubagentResult(payload, theme));
    usageLedger.resetUsageLedger();
    const after = renderToString(renderSubagentResult(payload, theme));
    expect(after).toBe(before);
    expect(after).toContain("3 spawned");
    expect(after).toContain("run $0.1000");
    expect(after).toContain("#2");
  });

  test("renders failed results with tally and run cost from available snapshot", () => {
    const theme = createDefaultFakeTheme();
    const text = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: persistedDetails({
            exitCode: 1,
            stopReason: "error",
            errorMessage: "boom",
          }),
        },
        theme,
      ),
    );
    expect(text).toContain("[error]");
    expect(text).toContain("3 spawned");
    expect(text).toContain("run $0.1000");
  });

  test("renders partial results with tally and run cost from available snapshot", () => {
    const theme = createDefaultFakeTheme();
    const text = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text" as const, text: "live partial" }],
          details: persistedDetails({ finalOutput: "" }),
        },
        theme,
        { isPartial: true },
      ),
    );
    expect(text).toContain("3 spawned");
    expect(text).toContain("run $0.1000");
    expect(text).toContain("live partial");
  });

  test("preserves legacy rendering without usageTree and for leaf snapshots", () => {
    const theme = createDefaultFakeTheme();
    const legacy = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: {
            mode: "single",
            agentScope: "both",
            projectAgentsDir: null,
            results: [
              makeSingleResult({
                agent: "build",
                instanceName: "brave-otter",
                finalOutput: "done",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0.005,
                  contextTokens: 0,
                  turns: 1,
                },
              }),
            ],
          },
        },
        theme,
      ),
    );
    expect(legacy).not.toContain("spawned");
    expect(legacy).not.toContain("run $");
    const leaf = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: {
            mode: "single",
            agentScope: "both",
            projectAgentsDir: null,
            results: [
              makeSingleResult({
                agent: "build",
                instanceName: "brave-otter",
                finalOutput: "done",
              }),
            ],
            usageTree: {
              id: "leaf-1",
              agent: "build",
              instanceName: "brave-otter",
              ordinal: 1,
              startedAt: 1,
              status: "success",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.005,
                turns: 1,
              },
              children: [],
            },
          },
        },
        theme,
      ),
    );
    expect(leaf).not.toContain("spawned");
    expect(leaf).not.toContain("run $");
  });

  test("retains ordinal threshold with persisted usageTree tally", () => {
    const theme = createDefaultFakeTheme();
    const repeated = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: persistedDetails(),
        },
        theme,
      ),
    );
    expect(repeated).toContain("#2");
    expect(repeated).toContain("3 spawned");
    const firstDetails = persistedDetails({ ordinal: 1 });
    if (firstDetails.usageTree) firstDetails.usageTree.ordinal = 1;
    const first = renderToString(
      renderSubagentResult(
        { content: [{ type: "text", text: "ignored" }], details: firstDetails },
        theme,
      ),
    );
    expect(first).not.toContain("#1");
    expect(first).toContain("3 spawned");
  });

  test("suppresses duplicate results and excludes task text from accounting lines", () => {
    const theme = createDefaultFakeTheme();
    const tool = getSubagentTool();
    const suppressed = renderToString(
      tool.renderResult?.(
        {
          content: [{ type: "text" as const, text: "done" }],
          details: {
            ...persistedDetails(),
            renderedByMessage: true as const,
          },
        } as never,
        { expanded: false, isPartial: false },
        theme as never,
        {} as never,
      ),
    );
    expect(suppressed).toBe("");
    const text = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text", text: "ignored" }],
          details: persistedDetails({ task: "secret-task-prompt-xyz" }),
        },
        theme,
      ),
    );
    const tallyLine = text
      .split("\n")
      .find((line) => line.includes("3 spawned"));
    expect(tallyLine).toBeDefined();
    expect(tallyLine).not.toContain("secret-task-prompt-xyz");
    expect(text).toContain("[success]");
  });

  test("retains full tally on a single line within wide card width", () => {
    const identity = {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
      italic: (t: string) => t,
      underline: (t: string) => t,
      strikethrough: (t: string) => t,
    };
    const payload = {
      content: [{ type: "text" as const, text: "ignored" }],
      details: persistedDetails(),
    };
    const width = 100;
    const rendered = renderToString(
      renderSubagentResult(payload, identity as never),
      width,
    );
    const lines = rendered.split("\n");
    const tallyLines = lines.filter((line) => line.includes("spawned"));
    expect(tallyLines).toHaveLength(1);
    const tally = tallyLines[0]?.trim() ?? "";
    expect(tally).toContain("3 spawned");
    expect(tally).toContain("fix");
    expect(tally).toContain("plan");
    expect(visibleWidth(tally)).toBeLessThanOrEqual(width - 2);
    const headerIdx = lines.findIndex((line) => line.includes("brave-otter"));
    const bodyIdx = lines.findIndex((line) => line.includes("persisted body"));
    const tallyIdx = lines.findIndex((line) => line.includes("3 spawned"));
    expect(bodyIdx).toBeGreaterThan(headerIdx);
    expect(tallyIdx).toBeGreaterThan(bodyIdx);
  });

  test("truncates trailing groups with accurate omission count on narrow cards", () => {
    const identity = {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
      italic: (t: string) => t,
      underline: (t: string) => t,
      strikethrough: (t: string) => t,
    };
    const payload = {
      content: [{ type: "text" as const, text: "ignored" }],
      details: persistedDetails(),
    };
    const width = 50;
    const rendered = renderToString(
      renderSubagentResult(payload, identity as never),
      width,
    );
    const lines = rendered.split("\n");
    const tallyLines = lines.filter((line) => line.includes("spawned"));
    expect(tallyLines).toHaveLength(1);
    const tally = tallyLines[0]?.trim() ?? "";
    expect(tally).toContain("3 spawned");
    expect(tally).toContain("+");
    expect(tally).toContain("more");
    expect(tally).toContain("run $0.1000");
    expect(visibleWidth(tally)).toBeLessThanOrEqual(width - 2);
    const headerIdx = lines.findIndex((line) => line.includes("brave-otter"));
    const bodyIdx = lines.findIndex((line) => line.includes("persisted body"));
    const tallyIdx = lines.findIndex((line) => line.includes("3 spawned"));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(headerIdx);
    expect(tallyIdx).toBeGreaterThan(bodyIdx);
    expect(rendered).not.toMatch(/provider.*run \$/);
  });

  test("suppresses tally below minimum width while hiding run cost", () => {
    const identity = {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
      italic: (t: string) => t,
      underline: (t: string) => t,
      strikethrough: (t: string) => t,
    };
    const payload = {
      content: [{ type: "text" as const, text: "ignored" }],
      details: persistedDetails(),
    };
    const rendered = renderToString(
      renderSubagentResult(payload, identity as never),
      15,
    );
    expect(rendered).not.toContain("spawned");
    expect(rendered).not.toContain("run $0.1000");
    expect(rendered.replace(/\s+/g, " ")).toContain("persisted body");
  });
  test("renders run cost and tally for omitted-only descendant accounting", () => {
    const theme = createDefaultFakeTheme();
    const omittedOnlyTree: UsageInstanceNode = {
      id: "root-omitted",
      agent: "build",
      instanceName: "brave-otter",
      ordinal: 2,
      startedAt: 1000,
      status: "success",
      durationMs: 1200,
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        turns: 1,
      },
      children: [],
      omitted: {
        count: 2,
        totals: {
          instances: 2,
          statuses: { running: 0, success: 2, error: 0, cancelled: 0 },
          usage: {
            input: 5,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.09,
            turns: 1,
          },
          durationMs: 100,
          byAgent: {
            plan: {
              instances: 2,
              statuses: { running: 0, success: 2, error: 0, cancelled: 0 },
              usage: {
                input: 5,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.09,
                turns: 1,
              },
              durationMs: 100,
            },
          },
        },
      },
    };
    const rendered = renderToString(
      renderSubagentResult(
        {
          content: [{ type: "text" as const, text: "ignored" }],
          details: { ...persistedDetails(), usageTree: omittedOnlyTree },
        },
        theme,
      ),
    );
    expect(rendered).toContain("2 spawned");
    expect(rendered.replace(/\s+/g, " ")).toContain("run $0.1000");
  });
});

test("display surfaces use semantic role hierarchy", () => {
  const theme = createDefaultFakeTheme();
  const tree: UsageInstanceNode = {
    id: "root-theme",
    agent: "build",
    instanceName: "theme-otter",
    ordinal: 2,
    startedAt: 1000,
    status: "success",
    durationMs: 1200,
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      turns: 1,
    },
    children: [
      {
        id: "c1",
        agent: "worker",
        instanceName: "c-one",
        ordinal: 1,
        startedAt: 1100,
        status: "success",
        durationMs: 100,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.005,
          turns: 1,
        },
        children: [],
      },
      {
        id: "c2",
        agent: "worker",
        instanceName: "c-two",
        ordinal: 1,
        startedAt: 1200,
        status: "success",
        durationMs: 100,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.005,
          turns: 1,
        },
        children: [],
      },
    ],
  };
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      makeSingleResult({
        agent: "build",
        instanceName: "theme-otter",
        ordinal: 2,
        finalOutput: "themed body",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.005,
          contextTokens: 0,
          turns: 1,
        },
      }),
    ],
    usageTree: tree,
  };
  const resultText = renderToString(
    renderSubagentResult(
      { content: [{ type: "text" as const, text: "ignored" }], details },
      theme,
    ),
  );
  expect(resultText).toContain("[muted][success][/muted]");
  const tallyLine =
    resultText.split("\n").find((l) => l.includes("spawned")) ?? "";
  expect(tallyLine).toContain("[muted]");
  expect(tallyLine).toContain("[dim] · [/dim]");
  expect(tallyLine).toContain("[muted]2 spawned[/muted]");
  expect(resultText).toContain("[dim]test-model");
  expect(resultText).not.toContain("[dim][success]");
  expect(resultText).not.toContain("[muted]test-model");
  const state: SubagentProgressState = {
    requestId: "theme-board",
    agent: "builder",
    taskPreview: "do",
    status: "running",
    startTime: Date.now() - 10000,
    toolCount: 1,
    modelDisplay: "provider/model:high",
  };
  const boardText = renderToString(renderRunsBoard([state], theme, 32));
  expect(boardText).toContain("[muted]*ACTIVE (1)*[/muted] [dim]");
  expect(boardText).toContain("[dim]provider/model:high[/dim]");
  expect(boardText).not.toContain("[muted]provider/model");
  expect(boardText).not.toContain("[dim][running]");
});
