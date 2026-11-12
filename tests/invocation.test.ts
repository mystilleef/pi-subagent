import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getPiInvocation,
  getSubagentDepth,
  subagentDepthEnv,
} from "../src/shared/invocation.js";
import { setupFixtureHooks } from "./fixtures.js";

setupFixtureHooks();

test("getPiInvocation keeps custom non-generic runtimes", () => {
  const originalArgv1 = process.argv[1] ?? "";
  const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
  process.argv[1] = path.join(tmpdir(), "missing-pi-entry.js");
  Object.defineProperty(process, "execPath", {
    value: "/opt/custom/pi-runtime",
    configurable: true,
  });
  try {
    expect(getPiInvocation(["--json"])).toEqual({
      command: "/opt/custom/pi-runtime",
      args: ["--json"],
    });
  } finally {
    process.argv[1] = originalArgv1;
    if (originalExecPath) {
      Object.defineProperty(process, "execPath", originalExecPath);
    } else {
      delete (process as unknown as { execPath?: string }).execPath;
    }
  }
});

describe("getSubagentDepth", () => {
  test("getSubagentDepth returns depth from environment", () => {
    process.env.PI_SUBAGENT_DEPTH = "3";
    expect(getSubagentDepth()).toBe(3);
    delete process.env.PI_SUBAGENT_DEPTH;
    expect(getSubagentDepth()).toBe(0);
  });
});

describe("subagentDepthEnv", () => {
  test("subagentDepthEnv returns depth environment variable", () => {
    process.env.PI_SUBAGENT_DEPTH = "5";
    const result = subagentDepthEnv();
    expect(result).toEqual({ PI_SUBAGENT_DEPTH: "6" });
    delete process.env.PI_SUBAGENT_DEPTH;
    const result2 = subagentDepthEnv();
    expect(result2).toEqual({ PI_SUBAGENT_DEPTH: "1" });
  });
});

describe("getPiInvocation", () => {
  test("getPiInvocation returns current script when argv[1] exists", () => {
    const originalArgv1 = process.argv[1] ?? "";
    const originalExecPath = process.execPath;

    try {
      // Create a temporary file to simulate existing script
      const tmpFile = path.join(os.tmpdir(), "test-pi-script");
      fs.writeFileSync(tmpFile, "#!/bin/sh\n");
      process.argv[1] = tmpFile;
      process.execPath = "/usr/bin/bun";

      const result = getPiInvocation(["--mode", "json"]);
      expect(result.command).toBe("/usr/bin/bun");
      expect(result.args).toEqual([tmpFile, "--mode", "json"]);

      // Cleanup
      fs.unlinkSync(tmpFile);
    } finally {
      process.argv[1] = originalArgv1;
      process.execPath = originalExecPath;
    }
  });
});

describe("getPiInvocation", () => {
  test.each([
    {
      name: "getPiInvocation returns pi command when script doesn't exist",
      execPath: "/usr/bin/bun",
      expectedCommand: "pi",
    },
    {
      name: "getPiInvocation returns exec path for non-generic runtimes",
      execPath: "/usr/bin/custom-runtime",
      expectedCommand: "/usr/bin/custom-runtime",
    },
    {
      name: "getPiInvocation handles .exe extension on Windows",
      execPath: "/usr/bin/bun.exe",
      expectedCommand: "pi",
    },
  ])("$name", (row) => {
    const originalArgv1 = process.argv[1] ?? "";
    const originalExecPath = process.execPath;

    try {
      process.argv[1] = "/non/existent/pi";
      process.execPath = row.execPath;

      const result = getPiInvocation(["--mode", "json"]);
      expect(result.command).toBe(row.expectedCommand);
      expect(result.args).toEqual(["--mode", "json"]);
    } finally {
      process.argv[1] = originalArgv1;
      process.execPath = originalExecPath;
    }
  });
});

describe("getSubagentDepth", () => {
  test.each([
    {
      name: "undefined depth defaults to 0 with next 1",
      value: undefined,
      depth: 0,
      nextDepth: "1",
    },
    {
      name: "not-a-number depth defaults to 0 with next 1",
      value: "not-a-number",
      depth: 0,
      nextDepth: "1",
    },
    {
      name: "Infinity depth defaults to 0 with next 1",
      value: "Infinity",
      depth: 0,
      nextDepth: "1",
    },
    {
      name: "negative depth defaults to 0 with next 1",
      value: "-1",
      depth: 0,
      nextDepth: "1",
    },
    {
      name: "negative fractional depth defaults to 0 with next 1",
      value: "-0.5",
      depth: 0,
      nextDepth: "1",
    },
    {
      name: "fractional depth below one defaults to 0 with next 1",
      value: "0.9",
      depth: 0,
      nextDepth: "1",
    },
    {
      name: "fractional depth above one floors with next 2",
      value: "1.7",
      depth: 1,
      nextDepth: "2",
    },
    {
      name: "integer depth passes through with next 3",
      value: "2",
      depth: 2,
      nextDepth: "3",
    },
  ])("$name", (row) => {
    const original = process.env.PI_SUBAGENT_DEPTH;
    try {
      if (row.value === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = row.value;
      expect(getSubagentDepth()).toBe(row.depth);
      expect(subagentDepthEnv()).toEqual({ PI_SUBAGENT_DEPTH: row.nextDepth });
    } finally {
      if (original === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = original;
    }
  });
});
