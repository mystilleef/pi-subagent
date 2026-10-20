import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_OUTPUT_LINES,
  detectMessageError,
  extractFinalOutputFromMessages,
  findLastAssistantTextMessage,
  getPiInvocation,
  getSubagentDepth,
  getSubagentOutputLimits,
  subagentDepthEnv,
  truncateOutput,
  writePromptToTempFile,
} from "../src/shared/utils.js";
import {
  assistantMessage,
  makeTempDir,
  setupHooks,
  toolResultMessage,
  userMessage,
} from "./helpers.js";

setupHooks();

test("utility helpers cover truncation, invocation, prompt files, depth, and message errors", async () => {
  expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(50_000);
  expect(DEFAULT_MAX_OUTPUT_LINES).toBe(500);
  const byLines = Array.from({ length: 501 }, (_v, i) => `line-${i}`).join(
    "\n",
  );
  const truncatedLines = truncateOutput(byLines);
  expect(truncatedLines).toContain("[TRUNCATED: first 500 of 501 lines]");
  expect(truncatedLines).not.toContain("line-500");
  const truncatedBytes = truncateOutput("é".repeat(50_000));
  expect(truncatedBytes).toContain("[TRUNCATED: first 1 of 1 lines]");
  expect(truncatedBytes).not.toContain("\uFFFD");
  expect(
    getSubagentOutputLimits({
      PI_SUBAGENT_MAX_OUTPUT_BYTES: "1234",
      PI_SUBAGENT_MAX_OUTPUT_LINES: "12",
    }),
  ).toEqual({ maxBytes: 1234, maxLines: 12 });
  expect(
    getSubagentOutputLimits({
      PI_SUBAGENT_MAX_OUTPUT_BYTES: "0",
      PI_SUBAGENT_MAX_OUTPUT_LINES: "invalid",
    }),
  ).toEqual({ maxBytes: 50_000, maxLines: 500 });
  const envLimited = truncateOutput("a\nb\nc", { maxBytes: 100, maxLines: 2 });
  expect(envLimited).toContain("[TRUNCATED: first 2 of 3 lines]");
  expect(envLimited).not.toContain("c");
  const scriptDir = await makeTempDir("pi-subagent-script-");
  const scriptPath = path.join(scriptDir, "pi-entry.js");
  await writeFile(scriptPath, "console.log('pi');\n");
  const originalArgv1 = process.argv[1] ?? "";
  process.argv[1] = scriptPath;
  try {
    expect(getPiInvocation(["--x"])).toEqual({
      command: process.execPath,
      args: [scriptPath, "--x"],
    });
  } finally {
    process.argv[1] = originalArgv1;
  }
  const promptFile = await writePromptToTempFile("agent name!*", "secret");
  try {
    expect(path.basename(promptFile.filePath)).toBe("prompt-agent_name_.md");
    expect(await writeFile(promptFile.filePath, "secret")).toBeUndefined(); // ensure it exists
    expect(await Bun.file(promptFile.filePath).text()).toBe("secret");
  } finally {
    await fsPromises.rm(promptFile.dir, { recursive: true, force: true });
    await expect(fsPromises.stat(promptFile.dir)).rejects.toThrow();
  }
  const originalDepth = process.env.PI_SUBAGENT_DEPTH;
  try {
    const cases: Array<[string | undefined, number, string]> = [
      [undefined, 0, "1"],
      ["not-a-number", 0, "1"],
      ["Infinity", 0, "1"],
      ["-1", 0, "1"],
      ["-0.5", 0, "1"],
      ["0.9", 0, "1"],
      ["1.7", 1, "2"],
      ["2", 2, "3"],
    ];
    for (const [value, depth, nextDepth] of cases) {
      if (value === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = value;
      expect(getSubagentDepth()).toBe(depth);
      expect(subagentDepthEnv()).toEqual({ PI_SUBAGENT_DEPTH: nextDepth });
    }
  } finally {
    if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = originalDepth;
  }
  expect(
    detectMessageError([
      { role: "toolResult", content: [], isError: true },
    ] as unknown as Message[]),
  ).toBe(true);
  expect(
    detectMessageError([
      { role: "toolResult", content: [], isError: true },
      { role: "assistant", content: [{ type: "text", text: "recovered" }] },
    ] as unknown as Message[]),
  ).toBe(false);
});

describe("utils.ts uncovered branches", () => {
  describe("writePromptToTempFile", () => {
    test("sanitizes agent name with special characters", async () => {
      const result = await writePromptToTempFile(
        "test agent!",
        "prompt content",
      );
      expect(result.dir).toBeDefined();
      expect(result.filePath).toContain("prompt-test_agent_.md");
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });

    test.each([
      {
        name: "sanitizes agent name with spaces",
        agentName: "my agent name",
        expectedFileName: "prompt-my_agent_name.md",
      },
      {
        name: "preserves alphanumeric and dots",
        agentName: "agent.v1",
        expectedFileName: "prompt-agent.v1.md",
      },
      {
        name: "preserves hyphens and underscores",
        agentName: "my-agent_v2",
        expectedFileName: "prompt-my-agent_v2.md",
      },
    ])("$name", async (row) => {
      const result = await writePromptToTempFile(row.agentName, "prompt");
      expect(result.filePath).toContain(row.expectedFileName);
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });

    test("writes prompt with correct permissions", async () => {
      const result = await writePromptToTempFile("test", "content");
      const stats = await fs.promises.stat(result.filePath);
      expect(stats.mode & 0o777).toBe(0o600);
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });

    test("writes prompt content correctly", async () => {
      const content = "# Test\n\nThis is a test prompt.";
      const result = await writePromptToTempFile("test", content);
      const written = await fs.promises.readFile(result.filePath, "utf-8");
      expect(written).toBe(content);
      await fs.promises.rm(result.dir, { recursive: true, force: true });
    });
  });

  describe("getPiInvocation", () => {
    test("returns execPath with current script when script exists", () => {
      const originalArgv1 = process.argv[1];
      process.argv[1] = import.meta.path;
      const result = getPiInvocation(["arg1", "arg2"]);
      expect(result.command).toBe(process.execPath);
      expect(result.args).toContain(import.meta.path);
      expect(result.args).toContain("arg1");
      expect(result.args).toContain("arg2");
      if (originalArgv1 !== undefined) {
        process.argv[1] = originalArgv1;
      }
    });

    test("includes all provided args", () => {
      const args = ["--verbose", "--config", "test.json"];
      const result = getPiInvocation(args);
      args.forEach((arg) => {
        expect(result.args).toContain(arg);
      });
    });
  });
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

  // ── Null / undefined text — nullish coalescing ────────────────

  test("returns empty string when text is null", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: null } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when text is undefined", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text" } as unknown as { type: string; text: string },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

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

  // ── Non-string text — typeof guard rejects in some() ──────────

  test("returns empty string when text is a number", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: 42 } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when text is a boolean", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: true } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when text is an object", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: { foo: "bar" } } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when text is an array", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: ["a"] } as unknown as {
          type: string;
          text: string;
        },
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

  test("returns empty string when content is not an array", () => {
    const msgs = [
      { role: "assistant", content: "plain string" },
    ] as unknown as Message[];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when content is null", () => {
    const msgs = [{ role: "assistant", content: null }] as unknown as Message[];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when content is undefined", () => {
    const msgs = [
      { role: "assistant", content: undefined },
    ] as unknown as Message[];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
  });

  test("returns empty string when assistant message has no content property", () => {
    const msgs = [{ role: "assistant" }] as unknown as Message[];
    expect(extractFinalOutputFromMessages(msgs)).toBe("");
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

  test("skips last assistant with null text and picks earlier valid", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "real output" }]),
      assistantMessage([
        { type: "text", text: null } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("real output");
  });

  test("skips last assistant with non-string text and picks earlier valid", () => {
    const msgs: Message[] = [
      assistantMessage([{ type: "text", text: "real output" }]),
      assistantMessage([
        { type: "text", text: 99 } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(extractFinalOutputFromMessages(msgs)).toBe("real output");
  });

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

  test("handles null text without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: null } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles undefined text without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text" } as unknown as { type: string; text: string },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles non-string text (number) without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: 42 } as unknown as { type: string; text: string },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles non-string text (boolean) without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: true } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles non-string text (object) without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: { foo: "bar" } } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("handles non-string text (array) without throwing", () => {
    const msgs: Message[] = [
      assistantMessage([
        { type: "text", text: ["a"] } as unknown as {
          type: string;
          text: string;
        },
      ]),
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

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

  test("assistant message with no content property returns -1", () => {
    const msgs = [{ role: "assistant" } as unknown as Message];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("assistant message with null content returns -1", () => {
    const msgs = [{ role: "assistant", content: null } as unknown as Message];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });

  test("assistant message with undefined content returns -1", () => {
    const msgs = [
      { role: "assistant", content: undefined } as unknown as Message,
    ];
    expect(() => findLastAssistantTextMessage(msgs)).not.toThrow();
    expect(findLastAssistantTextMessage(msgs)).toBe(-1);
  });
});
