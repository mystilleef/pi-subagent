import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  getAgentEndTimeoutExitCode,
  hasCompletedAgentOutput,
} from "../src/child/process.js";
import type { RuntimeResult } from "../src/child/result-builder.js";
import { formatContextPercent } from "../src/progress/progress-format.js";
import { makeSingleResult } from "./helpers.js";

function makeRuntimeResult(
  overrides: Partial<RuntimeResult> = {},
): RuntimeResult {
  const base = makeSingleResult(
    overrides as Partial<import("../src/shared/types.js").SingleResult>,
  );
  if (!("messages" in base)) {
    (base as RuntimeResult).messages = [];
  }
  return base as RuntimeResult;
}

describe("hasCompletedAgentOutput", () => {
  test("returns true when finalOutput has non-whitespace content", () => {
    const result = makeRuntimeResult({
      finalOutput: "some output",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result)).toBe(true);
  });

  test("returns true when finalOutput is whitespace-only but outcome has content", () => {
    const result = makeRuntimeResult({
      finalOutput: "   \n  ",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result, "completed successfully")).toBe(
      true,
    );
  });

  test("returns true when both finalOutput and outcome are empty but messages contain final output text", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "real output" }],
        } as unknown as Message,
      ],
    });
    expect(hasCompletedAgentOutput(result)).toBe(true);
  });

  test("returns false when finalOutput is empty and outcome is undefined", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result)).toBe(false);
  });

  test("returns false when finalOutput is only whitespace and outcome is empty", () => {
    const result = makeRuntimeResult({
      finalOutput: "   ",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result, "   ")).toBe(false);
  });

  test("returns true when outcome has content regardless of finalOutput state", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    expect(hasCompletedAgentOutput(result, "all done")).toBe(true);
  });

  test("returns false when messages exist but have no assistant text", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        } as unknown as Message,
      ],
    });
    expect(hasCompletedAgentOutput(result)).toBe(false);
  });
});

describe("getAgentEndTimeoutExitCode", () => {
  test("returns undefined when termination cancelReason is not agent_end_timeout", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "user_cancelled",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when termination is absent", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when spawnError is present", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    const spawnError = new Error("spawn failed");
    expect(
      getAgentEndTimeoutExitCode(result, spawnError, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when stopReason is error", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      stopReason: "error",
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when stopReason is aborted", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      stopReason: "aborted",
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns undefined when errorMessage has non-whitespace content", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      errorMessage: "something went wrong",
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(
      getAgentEndTimeoutExitCode(result, undefined, undefined),
    ).toBeUndefined();
  });

  test("returns 1 when errorMessage is whitespace-only and no output", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
      errorMessage: "   ",
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(1);
  });

  test("returns 0 when agent completed output and agent_end_timeout", () => {
    const result = makeRuntimeResult({
      finalOutput: "task completed",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(0);
  });

  test("returns 0 when outcome provides content for agent_end_timeout", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, "done")).toBe(0);
  });

  test("returns 1 when agent did not complete output and agent_end_timeout", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(1);
  });

  test("returns 0 when messages contain output for agent_end_timeout with no finalOutput", () => {
    const result = makeRuntimeResult({
      finalOutput: "",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "result text" }],
        } as unknown as Message,
      ],
    });
    result.termination = {
      cancelRequestedAt: Date.now(),
      escalated: false,
      processTreeKilled: false,
      target: "direct",
      cancelReason: "agent_end_timeout",
    };
    expect(getAgentEndTimeoutExitCode(result, undefined, undefined)).toBe(0);
  });
});

describe("formatContextPercent", () => {
  test("returns --% when contextWindowTokens is undefined", () => {
    expect(formatContextPercent({})).toBe("--%");
  });

  test("returns --% when contextWindowTokens is zero", () => {
    expect(formatContextPercent({ contextWindowTokens: 0 })).toBe("--%");
  });

  test("returns --% when contextWindowTokens is negative", () => {
    expect(formatContextPercent({ contextWindowTokens: -100 })).toBe("--%");
  });

  test("returns --% when contextWindowTokens is not finite", () => {
    expect(formatContextPercent({ contextWindowTokens: Number.NaN })).toBe(
      "--%",
    );
    expect(
      formatContextPercent({ contextWindowTokens: Number.POSITIVE_INFINITY }),
    ).toBe("--%");
  });

  test("returns 0% when contextTokens is undefined with valid window", () => {
    expect(formatContextPercent({ contextWindowTokens: 1000 })).toBe("0%");
  });

  test("returns 0% when contextTokens is zero with valid window", () => {
    expect(
      formatContextPercent({ contextTokens: 0, contextWindowTokens: 1000 }),
    ).toBe("0%");
  });

  test("returns 0% when contextTokens is negative with valid window", () => {
    expect(
      formatContextPercent({ contextTokens: -5, contextWindowTokens: 1000 }),
    ).toBe("0%");
  });

  test("returns 0% when contextTokens is not finite with valid window", () => {
    expect(
      formatContextPercent({
        contextTokens: Number.NaN,
        contextWindowTokens: 1000,
      }),
    ).toBe("0%");
  });

  test("returns correct percentage for valid inputs", () => {
    expect(
      formatContextPercent({ contextTokens: 500, contextWindowTokens: 1000 }),
    ).toBe("50%");
  });

  test("returns 100% when tokens equal window", () => {
    expect(
      formatContextPercent({ contextTokens: 1000, contextWindowTokens: 1000 }),
    ).toBe("100%");
  });

  test("rounds to nearest integer percent", () => {
    expect(
      formatContextPercent({ contextTokens: 333, contextWindowTokens: 1000 }),
    ).toBe("33%");
  });

  test("returns 0% for small fractions that round down", () => {
    expect(
      formatContextPercent({ contextTokens: 4, contextWindowTokens: 1000 }),
    ).toBe("0%");
  });

  test("handles large numbers correctly", () => {
    expect(
      formatContextPercent({
        contextTokens: 75000,
        contextWindowTokens: 200000,
      }),
    ).toBe("38%");
  });
});
