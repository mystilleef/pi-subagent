import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  detectMessageError,
  extractFinalOutputFromMessages,
  findLastAssistantTextMessage,
  hasSubagentFailed,
} from "../src/shared/message-utils.js";
import type { SingleResult } from "../src/shared/types.js";
import {
  assistantMessage,
  setupFixtureHooks,
  toolResultMessage,
  userMessage,
} from "./fixtures.js";

setupFixtureHooks();

test("hasSubagentFailed is false when outcome is set, even with detectMessageError true", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "running..." }],
    },
    { role: "toolResult", content: [], isError: true },
  ] as unknown as Message[];
  expect(detectMessageError(messages)).toBe(true);
  expect(
    hasSubagentFailed({
      agent: "test",
      agentSource: "user",
      task: "task",
      exitCode: 0,
      stopReason: "toolUse",
      outcome: "Task complete.",
      messages,
      stderr: "",
      finalOutput: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    }),
  ).toBe(false);
});

test("hasSubagentFailed is false when outcome is set despite non-zero exitCode", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ] as unknown as Message[];
  expect(
    hasSubagentFailed({
      agent: "test",
      agentSource: "user",
      task: "task",
      exitCode: 1,
      stopReason: "stop",
      outcome: "Completed anyway.",
      messages,
      stderr: "",
      finalOutput: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    }),
  ).toBe(false);
});

test("detectMessageError is true when error follows the final assistant message", () => {
  expect(
    detectMessageError([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
      },
      { role: "toolResult", content: [], isError: true },
    ] as unknown as Message[]),
  ).toBe(true);
});

test("detectMessageError is false when text assistant message follows error and no subsequent error", () => {
  expect(
    detectMessageError([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
      },
      { role: "toolResult", content: [], isError: true },
      {
        role: "assistant",
        content: [{ type: "text", text: "Recovered." }],
      },
    ] as unknown as Message[]),
  ).toBe(false);
});

/** Text parts whose `text` is absent or not a string. */
const INVALID_TEXT_PARTS = [
  { label: "null", part: { type: "text", text: null } },
  { label: "undefined", part: { type: "text" } },
  { label: "a number", part: { type: "text", text: 42 } },
  { label: "a boolean", part: { type: "text", text: true } },
  { label: "an object", part: { type: "text", text: { foo: "bar" } } },
  { label: "an array", part: { type: "text", text: ["a"] } },
];

/** Assistant messages whose `content` is nullish or absent. */
const MISSING_CONTENT_ASSISTANTS = [
  { label: "content is null", message: { role: "assistant", content: null } },
  {
    label: "content is undefined",
    message: { role: "assistant", content: undefined },
  },
  {
    label: "assistant message has no content property",
    message: { role: "assistant" },
  },
];

describe("hasSubagentFailed", () => {
  test("hasSubagentFailed detects various failure conditions", () => {
    expect(hasSubagentFailed({ exitCode: 1 } as unknown as SingleResult)).toBe(
      true,
    );
    expect(
      hasSubagentFailed({
        exitCode: 0,
        stopReason: "error",
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        stopReason: "aborted",
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        errorMessage: "something broke",
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "normal message" }],
            api: "fake",
            provider: "fake",
            model: "fake",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: 0,
          },
          {
            role: "toolResult",
            isError: true,
            content: [{ type: "text", text: "error output" }],
          },
        ] as Message[],
      } as unknown as SingleResult),
    ).toBe(true);
    expect(
      hasSubagentFailed({
        exitCode: 0,
        stopReason: "stop",
        errorMessage: "",
        messages: [],
      } as unknown as SingleResult),
    ).toBe(false);
  });
});

describe("detectMessageError", () => {
  test("detectMessageError detects error in messages", () => {
    expect(detectMessageError([])).toBe(false);
    expect(
      detectMessageError([
        {
          role: "assistant",
          content: [{ type: "text", text: "normal message" }],
          api: "fake",
          provider: "fake",
          model: "fake",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      ] as Message[]),
    ).toBe(false);
    expect(
      detectMessageError([
        {
          role: "assistant",
          content: [{ type: "text", text: "normal message" }],
          api: "fake",
          provider: "fake",
          model: "fake",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        },
        {
          role: "toolResult",
          isError: true,
          content: [{ type: "text", text: "error output" }],
        },
      ] as Message[]),
    ).toBe(true);
  });
});

test("detectMessageError is true for lone error tool result", () => {
  expect(
    detectMessageError([
      { role: "toolResult", content: [], isError: true },
    ] as unknown as Message[]),
  ).toBe(true);
});

test("detectMessageError is false when assistant recovers after lone error", () => {
  expect(
    detectMessageError([
      { role: "toolResult", content: [], isError: true },
      { role: "assistant", content: [{ type: "text", text: "recovered" }] },
    ] as unknown as Message[]),
  ).toBe(false);
});

describe("extractFinalOutputFromMessages", () => {
  // ── Happy path ────────────────────────────────────────────────

  test.each([
    {
      name: "returns last text part from last assistant message with valid text",
      text: "hello",
      expected: "hello",
    },
    {
      name: "returns text with surrounding whitespace as-is (not trimmed)",
      text: "  hello world  ",
      expected: "  hello world  ",
    },
    {
      name: "returns empty string when all text parts are whitespace-only",
      text: "   \n \t  ",
      expected: "",
    },
  ])("$name", (row) => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: row.text }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe(row.expected);
  });

  test("returns last text part in mixed content (text + tool calls)", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
        { type: "text", text: "result" },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("result");
  });

  test("returns last text part when earlier text parts precede tool calls", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "starting" },
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
        { type: "text", text: "done" },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("done");
  });

  test.each([
    {
      name: "returns text from last assistant when multiple assistants exist",
      firstText: "first",
      secondText: "second",
      expected: "second",
    },
    {
      name: "skips last assistant with only whitespace text and picks earlier valid",
      firstText: "real output",
      secondText: "   \n  \t",
      expected: "real output",
    },
    {
      name: "skips last assistant with only empty text and picks earlier valid",
      firstText: "real output",
      secondText: "",
      expected: "real output",
    },
  ])("$name", (row) => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: row.firstText }]),
      assistantMessage([{ type: "text", text: row.secondText }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe(row.expected);
  });

  // ── Null, undefined, and non-string text ──────────────────────

  test.each(INVALID_TEXT_PARTS)(
    "returns empty string when text is $label",
    ({ part }) => {
      expect(extractFinalOutputFromMessages([assistantMessage([part])])).toBe(
        "",
      );
    },
  );

  test("returns empty string when last text part has null text but earlier part has valid text", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "valid" },
        {
          type: "text",
          text: null,
        } as unknown as { type: string; text: string },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  // ── Whitespace-only / empty text ──────────────────────────────

  test("returns empty string when all text parts are empty", () => {
    const msgs: Message[] = [assistantMessage([{ type: "text", text: "" }])];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when message has only whitespace-only and empty text parts", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "\t  " },
        { type: "text", text: "" },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns whitespace text as-is when message has one valid text part and the last text part is whitespace", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "valid" },
        { type: "text", text: "   " },
      ]),
    ];
    // The some() check matches the message because of "valid".
    // findLast finds the last text part ("   "), which is returned as-is.
    expect(extractFinalOutputFromMessages(msgs)).toBe("   ");
  });

  // ── Non-array / missing content ───────────────────────────────

  test.each([
    {
      label: "content is not an array",
      message: { role: "assistant", content: "plain string" },
    },
    ...MISSING_CONTENT_ASSISTANTS,
  ])("returns empty string when $label", ({ message }) => {
    expect(
      extractFinalOutputFromMessages([message as unknown as Message]),
    ).toBe("");
  });

  // ── No valid assistant messages ───────────────────────────────

  test("returns empty string for empty messages array", () => {
    expect(extractFinalOutputFromMessages([])).toBe("");
  });

  test("returns empty string when no assistant messages exist", () => {
    const msgs: Message[] = [userMessage(), userMessage()];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when only toolResult messages exist", () => {
    const msgs: Message[] = [toolResultMessage(), toolResultMessage(true)];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when assistants have only tool calls", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when assistants have only thinking content", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "thinking", thinking: "deep thoughts" }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  // ── Interleaved roles — only assistant messages considered ────

  test("skips non-assistant messages between assistants", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "first" }]),
      userMessage(),
      toolResultMessage(),
      assistantMessage([{ type: "text", text: "last" }]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("last");
  });

  test.each([
    { label: "null", text: null },
    { label: "non-string", text: 99 },
  ])(
    "skips last assistant with $label text and picks earlier valid",
    ({ text }) => {
      const msgs: Message[] = [
        assistantMessage([{ type: "text", text: "real output" }]),
        assistantMessage([{ type: "text", text }]),
      ];
      expect(extractFinalOutputFromMessages(msgs)).toBe("real output");
    },
  );

  // ── Multi-text messages where valid text exists with invalid last part ──

  test("extracts last text part even when earlier part was the qualifying one in some()", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: "qualifying" }, // passes some() check
        { type: "toolCall", id: "tc1", name: "bash", arguments: {} },
        { type: "text", text: "final" }, // returned by findLast
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("final");
  });

  // ── Malformed content parts ───────────────────────────────────

  test("throws when content part is null (cannot access type on null)", () => {
    const msgs: Message[] = [
      assistantMessage([null as unknown as { type: string; text: string }]),
    ];
    expect(() => extractFinalOutputFromMessages(msgs)).toThrow();
  });

  test("returns empty string when content part has no type property", () => {
    const msgs: Message[] = [
      assistantMessage([
        { text: "no type" } as unknown as { type: string; text: string },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });
});

describe("findLastAssistantTextMessage", () => {
  test("empty array returns -1", () => {
    expect(findLastAssistantTextMessage([])).toBe(-1);
  });

  test("no assistant messages returns -1", () => {
    const msgs: Message[] = [userMessage(), userMessage()];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("only toolResult messages returns -1", () => {
    const msgs: Message[] = [toolResultMessage(), toolResultMessage(true)];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test.each([
    { name: "all assistant messages with empty text returns -1", text: "" },
    {
      name: "all assistant messages with whitespace-only text returns -1",
      text: "   ",
    },
    { name: "single element — assistant with empty text returns -1", text: "" },
  ])("$name", (row) => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: row.text }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test.each([
    {
      name: "single element — assistant with non-empty text returns 0",
      text: "hello",
    },
    {
      name: "text with surrounding whitespace — trims and finds text",
      text: "  hello world  ",
    },
  ])("$name", (row) => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: row.text }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(0);
  });

  test("single element — non-assistant returns -1", () => {
    const msgs: Message[] = [userMessage()];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("last element is the target", () => {
    const msgs: Message[] = [
      userMessage(),
      assistantMessage([{ type: "text", text: "hello" }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(1);
  });

  test("multiple candidates — last matching one wins", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "first" }]),
      assistantMessage([{ type: "text", text: "" }]),
      assistantMessage([{ type: "text", text: "last" }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(2);
  });

  test("multiple candidates — later empty doesn't override earlier valid", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "valid" }]),
      assistantMessage([{ type: "text", text: "" }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(0);
  });

  test("assistant with mixed content — text takes precedence over tool calls", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "toolCall", id: "tc1", name: "t", arguments: {} },
        { type: "text", text: "result" },
      ]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(0);
  });

  test("assistant with only tool calls — returns -1", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "toolCall", id: "tc1", name: "t", arguments: {} },
      ]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("assistant with only thinking content — returns -1", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "thinking", thinking: "deep thoughts" }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("whitespace-only treated as empty (tab, newline, spaces)", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "\t\n  " }]),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test.each(INVALID_TEXT_PARTS)(
    "returns -1 when text is $label",
    ({ part }) => {
      expect(findLastAssistantTextMessage([assistantMessage([part])])).toBe(-1);
    },
  );

  test("interleaved roles — only assistant messages considered", () => {
    const msgs: Message[] = [
      userMessage(),
      assistantMessage([{ type: "text", text: "first" }]),
      toolResultMessage(),
      userMessage(),
      assistantMessage([{ type: "text", text: "second" }]),
      toolResultMessage(true),
    ];
    expect(findLastAssistantTextMessage(msgs)).toBe(4);
  });

  test.each(MISSING_CONTENT_ASSISTANTS)(
    "returns -1 when $label",
    ({ message }) => {
      expect(
        findLastAssistantTextMessage([message as unknown as Message]),
      ).toBe(-1);
    },
  );
});
