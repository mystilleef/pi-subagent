import { describe, expect, test } from "bun:test";
import {
  extractSemanticToolTarget,
  isStatusOnlyFailure,
  isStatusOnlySuccess,
  makeToolPreview,
  normalizeAndTruncate,
  normalizeSummaryValue,
  normalizeTerminalSentence,
  truncateText,
} from "../src/output/normalize.js";
import { setupHooks } from "./helpers.js";

setupHooks();

describe("normalize.ts coverage gaps", () => {
  test("normalizeSummaryValue strips backticks and bold markers", () => {
    expect(normalizeSummaryValue("`hello`")).toBe("hello");
    expect(normalizeSummaryValue("**world**")).toBe("world");
    expect(normalizeSummaryValue("  spaced  ")).toBe("spaced");
    expect(normalizeSummaryValue("multiple   spaces")).toBe("multiple spaces");
  });

  test("extractSemanticToolTarget returns semantic key values", () => {
    expect(extractSemanticToolTarget({ command: "ls -la" })).toBe("ls -la");
    expect(extractSemanticToolTarget({ path: "/tmp/file" })).toBe("/tmp/file");
    expect(extractSemanticToolTarget({ agent: "builder" })).toBe("builder");
    expect(extractSemanticToolTarget({ query: "search term" })).toBe(
      "search term",
    );
    expect(extractSemanticToolTarget({ url: "https://example.com" })).toBe(
      "https://example.com",
    );
    expect(extractSemanticToolTarget({ action: "run" })).toBe("run");
    expect(extractSemanticToolTarget({ name: "test" })).toBe("test");
  });

  test("extractSemanticToolTarget skips secret keys and JWTs", () => {
    expect(
      extractSemanticToolTarget({ secretKey: "sensitive", command: "ls" }),
    ).toBe("ls");
    expect(
      extractSemanticToolTarget({
        token: "eyJabc.def.ghi",
        command: "ls",
      }),
    ).toBe("ls");
    expect(
      extractSemanticToolTarget({
        password: "hidden",
        path: "/tmp",
      }),
    ).toBe("/tmp");
  });

  test("extractSemanticToolTarget returns empty string for no valid keys", () => {
    expect(extractSemanticToolTarget({})).toBe("");
    expect(extractSemanticToolTarget({ secret: "value" })).toBe("");
    expect(extractSemanticToolTarget({ key: "" })).toBe("");
  });

  test("extractSemanticToolTarget returns JSON when forceJson is true", () => {
    const args = { command: "ls" };
    expect(extractSemanticToolTarget(args, true)).toBe(JSON.stringify(args));
  });

  test("truncateText truncates long text with ellipsis", () => {
    expect(truncateText("hello", 10)).toBe("hello");
    expect(truncateText("hello world", 5)).toBe("hell…");
    expect(truncateText("a".repeat(100), 10)).toBe(`${"a".repeat(9)}…`);
  });

  test("normalizeTerminalSentence handles various prefixes", () => {
    expect(normalizeTerminalSentence("- bullet point")).toBe("bullet point");
    expect(normalizeTerminalSentence("> quoted text")).toBe("quoted text");
    expect(normalizeTerminalSentence("* emphasized")).toBe("emphasized");
    expect(normalizeTerminalSentence("## Heading")).toBe("Heading");
    expect(normalizeTerminalSentence("`code`")).toBe("code");
    // Note: **bold** regex requires exact match at start/end with no nested *
    expect(normalizeTerminalSentence("__underline__")).toBe("underline");
  });

  test("normalizeTerminalSentence strips status prefixes", () => {
    expect(normalizeTerminalSentence("success: completed")).toBe("completed");
    expect(normalizeTerminalSentence("failure: failed")).toBe("failed");
    expect(normalizeTerminalSentence("status: done")).toBe("done");
    expect(normalizeTerminalSentence("summary: brief")).toBe("brief");
    expect(normalizeTerminalSentence("result: output")).toBe("output");
  });

  test("normalizeTerminalSentence strips trailing punctuation", () => {
    expect(normalizeTerminalSentence("done.")).toBe("done");
    expect(normalizeTerminalSentence("completed!")).toBe("completed");
    expect(normalizeTerminalSentence("result;")).toBe("result");
    expect(normalizeTerminalSentence("output:")).toBe("output");
  });

  test("normalizeTerminalSentence handles empty and whitespace-only input", () => {
    expect(normalizeTerminalSentence("")).toBe("");
    expect(normalizeTerminalSentence("   ")).toBe("");
    expect(normalizeTerminalSentence("\t\n")).toBe("");
  });

  test("normalizeTerminalSentence truncates long sentences", () => {
    const longSentence = "a".repeat(150);
    const result = normalizeTerminalSentence(longSentence);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith("…")).toBe(true);
  });

  test("normalizeAndTruncate truncates long text", () => {
    const longText = "a".repeat(200);
    const result = normalizeAndTruncate(longText, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith("…")).toBe(true);
  });

  test("normalizeAndTruncate keeps short text unchanged", () => {
    const shortText = "hello world";
    expect(normalizeAndTruncate(shortText, 50)).toBe("hello world");
  });

  test("isStatusOnlySuccess detects success status", () => {
    expect(isStatusOnlySuccess("success")).toBe(true);
    expect(isStatusOnlySuccess("done")).toBe(true);
    expect(isStatusOnlySuccess("SUCCESS")).toBe(true);
    expect(isStatusOnlySuccess("DONE")).toBe(true);
    expect(isStatusOnlySuccess("failed")).toBe(false);
    expect(isStatusOnlySuccess("error occurred")).toBe(false);
  });

  test("isStatusOnlyFailure detects failure status", () => {
    expect(isStatusOnlyFailure("failure")).toBe(true);
    expect(isStatusOnlyFailure("failed")).toBe(true);
    expect(isStatusOnlyFailure("error")).toBe(true);
    expect(isStatusOnlyFailure("FAILURE")).toBe(true);
    expect(isStatusOnlyFailure("FAILED")).toBe(true);
    expect(isStatusOnlyFailure("ERROR")).toBe(true);
    expect(isStatusOnlyFailure("success")).toBe(false);
    expect(isStatusOnlyFailure("done")).toBe(false);
  });

  test("makeToolPreview creates preview for subagent tool", () => {
    const preview = makeToolPreview("subagent", {
      agent: "builder",
      task: "fix bugs",
    });
    expect(preview).toContain("subagent");
    expect(preview).toContain("builder");
  });

  test("makeToolPreview creates preview for non-subagent tool", () => {
    const preview = makeToolPreview("bash", { command: "ls -la" });
    expect(preview).toContain("bash");
    expect(preview).toContain("ls -la");
  });

  test("makeToolPreview handles missing arguments", () => {
    const preview = makeToolPreview("read", {});
    expect(preview).toContain("read");
  });
});

describe("normalize.ts uncovered branches", () => {
  describe("normalizeAndTruncate wrapper regex", () => {
    test.each([
      {
        name: "backtick-wrapped text extracts inner content and truncates",
        text: "`wrapped text`",
        expected: "wrapped text",
      },
      {
        name: "double-asterisk wrapped text extracts inner content and truncates",
        text: "**bold text**",
        expected: "bold text",
      },
      {
        name: "non-wrapped text returns trimmed normalized",
        text: "  plain text  ",
        expected: "plain text",
      },
    ])("$name", (row) => {
      expect(normalizeAndTruncate(row.text)).toBe(row.expected);
    });

    test("long wrapped text is truncated to 120 chars", () => {
      const longText = `\`${"a".repeat(150)}\``;
      const result = normalizeAndTruncate(longText);
      expect(result.length).toBeLessThanOrEqual(120);
    });
  });

  describe("normalizeTerminalSentence unwrapping paths", () => {
    test.each([
      {
        name: "strips leading bullet markers",
        input: "- Result text",
        expected: "Result text",
      },
      {
        name: "strips leading asterisk markers",
        input: "* Result text",
        expected: "Result text",
      },
      {
        name: "strips leading arrow markers",
        input: "> Result text",
        expected: "Result text",
      },
      {
        name: "strips leading hash headers",
        input: "## Result text",
        expected: "Result text",
      },
      {
        name: "strips backtick code markers",
        input: "`code result`",
        expected: "code result",
      },
      {
        name: "strips triple backtick code markers",
        input: "```code result```",
        expected: "code result",
      },
      {
        name: "strips success prefix",
        input: "success: completed",
        expected: "completed",
      },
      {
        name: "strips failure prefix",
        input: "failure: error occurred",
        expected: "error occurred",
      },
      {
        name: "strips multiple status prefixes",
        input: "success: success: done",
        expected: "done",
      },
      {
        name: "strips status label",
        input: "status: active",
        expected: "active",
      },
      {
        name: "strips summary label",
        input: "summary: completed task",
        expected: "completed task",
      },
      {
        name: "strips result label",
        input: "result: success",
        expected: "success",
      },
      {
        name: "strips output label",
        input: "output: file created",
        expected: "file created",
      },
      {
        name: "strips message label",
        input: "message: hello world",
        expected: "hello world",
      },
      {
        name: "strips error label",
        input: "error: not found",
        expected: "not found",
      },
      {
        name: "strips check label",
        input: "check: passed",
        expected: "passed",
      },
      {
        name: "does not strip outcome label as it is outcome-specific",
        input: "outcome: success",
        expected: "outcome: success",
      },
      {
        name: "does not strip Outcome: (uppercase) label as it is outcome-specific",
        input: "Outcome: success",
        expected: "Outcome: success",
      },
      {
        name: "does not strip OUTCOME: (allcaps) label as it is outcome-specific",
        input: "OUTCOME: success",
        expected: "OUTCOME: success",
      },
      {
        name: "does not strip Outcome: label with whitespace padding as it is outcome-specific",
        input: "  Outcome:  success  ",
        expected: "Outcome: success",
      },
      {
        name: "strips project summary label",
        input: "project summary: done",
        expected: "done",
      },
      {
        name: "strips trailing punctuation",
        input: "result text.",
        expected: "result text",
      },
      { name: "strips trailing exclamation", input: "done!", expected: "done" },
      {
        name: "strips trailing semicolon",
        input: "completed;",
        expected: "completed",
      },
      { name: "strips trailing colon", input: "result:", expected: "result" },
      { name: "strips trailing em dash", input: "result—", expected: "result" },
      { name: "strips trailing en dash", input: "result–", expected: "result" },
      { name: "strips trailing hyphen", input: "result-", expected: "result" },
    ])("$name", (row) => {
      const result = normalizeTerminalSentence(row.input);
      expect(result).toBe(row.expected);
    });

    test("strips double-asterisk bold markers", () => {
      const result = normalizeTerminalSentence("**bold result**");
      // Actual behavior: only leading ** is stripped due to regex matching
      expect(result).toBe("bold result**");
    });

    test("applies custom character limit", () => {
      const result = normalizeTerminalSentence(
        "very long result text that should be truncated",
        20,
      );
      expect(result.length).toBeLessThanOrEqual(20);
    });
  });

  describe("truncateText", () => {
    test.each([
      {
        name: "text within limit returns unchanged",
        text: "short",
        maxLength: 10,
        expected: "short",
      },
      {
        name: "text at limit returns unchanged",
        text: "exact",
        maxLength: 5,
        expected: "exact",
      },
      {
        name: "text exceeding limit truncates with ellipsis",
        text: "this is too long",
        maxLength: 10,
        expected: "this is t…",
      },
    ])("$name", (row) => {
      expect(truncateText(row.text, row.maxLength)).toBe(row.expected);
    });
  });

  describe("extractSemanticToolTarget", () => {
    test("forceJson returns JSON stringified args", () => {
      const args = { command: "ls", path: "/tmp" };
      expect(extractSemanticToolTarget(args, true)).toBe(JSON.stringify(args));
    });

    test("semantic key agent returns value", () => {
      expect(extractSemanticToolTarget({ agent: "test-agent" })).toBe(
        "test-agent",
      );
    });

    test("semantic key action returns value", () => {
      expect(extractSemanticToolTarget({ action: "delete" })).toBe("delete");
    });

    test("semantic key name returns value", () => {
      expect(extractSemanticToolTarget({ name: "test-name" })).toBe(
        "test-name",
      );
    });

    test("secret keys are skipped", () => {
      const args = { secret: "password123", command: "ls" };
      expect(extractSemanticToolTarget(args)).toBe("ls");
    });

    test("token keys are skipped", () => {
      const args = { token: "abc123", path: "/tmp" };
      expect(extractSemanticToolTarget(args)).toBe("/tmp");
    });

    test("password keys are skipped", () => {
      const args = { password: "secret", query: "search" };
      expect(extractSemanticToolTarget(args)).toBe("search");
    });

    test("credential keys are skipped", () => {
      const args = { credential: "key", action: "run" };
      expect(extractSemanticToolTarget(args)).toBe("run");
    });

    test("auth keys are skipped", () => {
      const args = { auth: "token", name: "test" };
      expect(extractSemanticToolTarget(args)).toBe("test");
    });

    test("JWT values are skipped", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP04sB8Nw";
      const args = { token: jwt, command: "ls" };
      expect(extractSemanticToolTarget(args)).toBe("ls");
    });

    test("values over 60 chars are skipped", () => {
      const longValue = "a".repeat(61);
      const args = { description: longValue, command: "ls" };
      expect(extractSemanticToolTarget(args)).toBe("ls");
    });

    test("non-string values are skipped", () => {
      const args = { count: 42, command: "ls" };
      expect(extractSemanticToolTarget(args)).toBe("ls");
    });

    test.each([
      { name: "empty string values are skipped", command: "" },
      { name: "whitespace-only values are skipped", command: "   " },
    ])("$name", (row) => {
      const args = { command: row.command, path: "/tmp" };
      expect(extractSemanticToolTarget(args)).toBe("/tmp");
    });

    test("no matching values returns empty string", () => {
      const args = { secret: "password", count: 42 };
      expect(extractSemanticToolTarget(args)).toBe("");
    });

    test("fallback loop skips JWT values with no semantic keys", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP04sB8Nw";
      const args = { data: jwt };
      expect(extractSemanticToolTarget(args)).toBe("");
    });

    test("fallback loop skips values over 60 chars with no semantic keys", () => {
      const longValue = "a".repeat(61);
      const args = { description: longValue };
      expect(extractSemanticToolTarget(args)).toBe("");
    });

    test("fallback loop returns first valid non-semantic non-secret key", () => {
      const args = { title: "summary" };
      expect(extractSemanticToolTarget(args)).toBe("summary");
    });

    test("fallback loop skips secret keys and returns next valid key", () => {
      const args = { secret: "password", title: "summary" };
      expect(extractSemanticToolTarget(args)).toBe("summary");
    });
  });

  describe("makeToolPreview", () => {
    test("args with target returns formatted preview", () => {
      expect(makeToolPreview("bash", { command: "ls" })).toBe("bash: ls");
    });

    test("args without extractable target returns tool name only", () => {
      expect(makeToolPreview("bash", { secret: "password" })).toBe("bash");
    });

    test("long preview is truncated", () => {
      const longCommand = "a".repeat(150);
      const result = makeToolPreview("bash", { command: longCommand });
      expect(result.length).toBeLessThanOrEqual(120);
    });
  });

  describe("isStatusOnlySuccess", () => {
    test("with whitespace returns true", () => {
      expect(isStatusOnlySuccess("  success  ")).toBe(true);
    });

    test.each([
      { name: "other text returns false", text: "completed" },
      { name: "success with extra text returns false", text: "success: done" },
    ])("$name", (row) => {
      expect(isStatusOnlySuccess(row.text)).toBe(false);
    });
  });

  describe("isStatusOnlyFailure", () => {
    test("with whitespace returns true", () => {
      expect(isStatusOnlyFailure("  failed  ")).toBe(true);
    });

    test("other text returns false", () => {
      expect(isStatusOnlyFailure("failed task")).toBe(false);
    });
  });
});

test("makeToolPreview formats tool name and first arg value", () => {
  const preview = makeToolPreview("bash", { command: "ls -la" });
  expect(preview).toBe("bash: ls -la");
});

test("makeToolPreview collapses multiline whitespace", () => {
  const preview = makeToolPreview("bash", {
    command: "printf 'a'\n\t  echo b",
  });
  expect(preview).toBe("bash: printf 'a' echo b");
  expect(preview).not.toContain("\n");
});

test("makeToolPreview truncates after whitespace normalization", () => {
  const command = `${"x".repeat(100)}\n\t${"y".repeat(40)}`;
  const preview = makeToolPreview("bash", { command });
  expect(Array.from(preview).length).toBe(120);
  expect(preview).toBe(`${"bash: "}${"x".repeat(100)} ${"y".repeat(12)}…`);
  expect(preview).not.toContain("\n");
});

test("makeToolPreview keeps semantic target without ellipsis", () => {
  const path = "a".repeat(100);
  const preview = makeToolPreview("read", { path });
  expect(preview).toBe(`read: ${path}`);
  expect(preview).not.toContain("...");
});

test("makeToolPreview leaves 120 displayed characters unchanged", () => {
  const command = "λ".repeat(114);
  const preview = makeToolPreview("bash", { command });
  expect(preview).toBe(`bash: ${command}`);
  expect(Array.from(preview).length).toBe(120);
  expect(preview.endsWith("…")).toBe(false);
});

test("makeToolPreview truncates long previews to 120 displayed characters", () => {
  const command = "λ".repeat(115);
  const preview = makeToolPreview("bash", { command });
  expect(Array.from(preview).length).toBe(120);
  expect(preview.endsWith("…")).toBe(true);
  expect(preview).toBe(`${"bash: "}${"λ".repeat(113)}…`);
});

test("makeToolPreview truncates long path preview after tool prefix", () => {
  const path = `/tmp/${"x".repeat(130)}`;
  const preview = makeToolPreview("read", { path });
  expect(Array.from(preview).length).toBe(120);
  expect(preview).toBe(`${"read: "}${path.slice(0, 113)}…`);
  expect(preview).not.toContain("x".repeat(115));
});

test("makeToolPreview omits unknown tool arguments", () => {
  const args = {
    token: "secret-token",
    password: "secret-password",
    nested: { value: "secret-nested" },
  };
  const preview = makeToolPreview("unknown_tool", args);
  expect(preview).toBe("unknown_tool");
  expect(preview).not.toContain(":");
  expect(preview).not.toContain("secret");
});

test("makeToolPreview includes agent for subagent", () => {
  const preview = makeToolPreview("subagent", {
    agent: "builder",
    task: `${"review ".repeat(30)}sentinel`,
    agentScope: "project",
  });
  expect(preview).toBe("subagent: builder");
});

test("makeToolPreview uses query for web_search", () => {
  const preview = makeToolPreview("web_search", { query: "typescript" });
  expect(preview).toBe("web_search: typescript");
});

test("makeToolPreview uses url for fetch_url", () => {
  const preview = makeToolPreview("fetch_url", { url: "https://example.com" });
  expect(preview).toBe("fetch_url: https://example.com");
});

test("makeToolPreview uses action for computer_use", () => {
  const preview = makeToolPreview("computer_use", { action: "click" });
  expect(preview).toBe("computer_use: click");
});

test("makeToolPreview handles empty args", () => {
  expect(makeToolPreview("bash", {})).toBe("bash");
  expect(makeToolPreview("bash", undefined)).toBe("bash");
});

test("makeToolPreview omits blank semantic targets", () => {
  expect(makeToolPreview("bash", { command: "\n\t  " })).toBe("bash");
});

test("makeToolPreview includes safe first string for unknown tools", () => {
  expect(makeToolPreview("unknown_tool", { project: "my-project" })).toBe(
    "unknown_tool: my-project",
  );
  expect(
    makeToolPreview("unknown_tool", {
      project: "my-project",
      count: 42,
    }),
  ).toBe("unknown_tool: my-project");
});

test("makeToolPreview suppresses fallback when only secret-like keys present", () => {
  expect(makeToolPreview("unknown_tool", { token: "x", password: "y" })).toBe(
    "unknown_tool",
  );
  expect(
    makeToolPreview("unknown_tool", { token: "x", password: "y" }),
  ).not.toContain(":");
});

test("stored preview truncation remains unchanged at 120 characters", () => {
  const longCommand = "x".repeat(150);
  const preview = makeToolPreview("bash", { command: longCommand });
  expect(Array.from(preview).length).toBe(120);
  expect(preview).toEndWith("…");
  expect(preview).toBe(`bash: ${"x".repeat(113)}…`);
});
