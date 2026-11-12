import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/agent/agents.js";
import { discoverAgentsAsync } from "../src/agent/agents.js";
import { runSingleAgent } from "../src/child/process.js";
import { resolvePackageExtensionPath } from "../src/child/process-utils.js";
import { resetResolvedAgentExtensionPathsCache } from "../src/shared/resource-resolution.js";
import type { SingleResult } from "../src/shared/types.js";
import {
  CAPTURE_ARGS_PI_SCRIPT,
  CAPTURE_PI_ARGS_SH,
  captureRunSingleAgentArgs,
  emitAgentEnd,
  emitMessageEnd,
  flagValues,
  hangAgent,
  makeAssistantMessage,
  makeModelAgent,
  makeSubagentDetails,
  readCapturedArgs,
  setupFakePi,
  setupHooks,
  setupTest,
} from "./helpers.js";

setupHooks();

test("runSingleAgent injects the complete extension", async () => {
  const args = await captureRunSingleAgentArgs(makeModelAgent({}), undefined);
  expect(args).toContain("--extension");
  const extPaths = flagValues(args, "--extension");
  expect(extPaths.length).toBe(1);
  expect(extPaths[0] ?? "").toContain("complete-extension");
});

test("runSingleAgent omits --tools when agent has no tools", async () => {
  const args = await captureRunSingleAgentArgs(makeModelAgent({}), undefined);
  expect(args).not.toContain("--tools");
});

test("runSingleAgent appends complete to the agent tool allowlist", async () => {
  const agent = makeModelAgent({ tools: ["read", "write"] });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["read", "write", "complete"]);
  expect(agent.tools).toEqual(["read", "write"]);
});

test("runSingleAgent preserves existing complete in the tool allowlist", async () => {
  const agent = makeModelAgent({ tools: ["read", "complete", "write"] });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["read", "complete", "write"]);
  expect(agent.tools).toEqual(["read", "complete", "write"]);
});

test("runSingleAgent injects complete into an empty tool allowlist", async () => {
  const agent = makeModelAgent({ tools: [] });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["complete"]);
  expect(agent.tools).toEqual([]);
});

test("runSingleAgent deduplicates complete in the tool allowlist", async () => {
  const agent = makeModelAgent({
    tools: ["read", "complete", "complete", "write", "complete"],
  });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["read", "complete", "write"]);
  expect(agent.tools).toEqual([
    "read",
    "complete",
    "complete",
    "write",
    "complete",
  ]);
});

describe("Wire child-scoped sampling env and extension loading", () => {
  async function runCapturedAgentWithParams(
    agent: AgentConfig,
  ): Promise<{ args: string[]; envSampling: string; result: SingleResult }> {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' "$PI_SAMPLING_PARAMS" > env_sampling.txt
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
exit 0
`,
    });
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    const args = await readCapturedArgs(cwd);
    const envSampling = fs
      .readFileSync(path.join(cwd, "env_sampling.txt"), "utf8")
      .trim();
    return { args, envSampling, result };
  }

  function getExtensionPaths(args: string[]): string[] {
    return args.flatMap((arg, i) =>
      arg === "--extension" ? [args[i + 1] ?? ""] : [],
    );
  }

  function expectExtensions(args: string[], count: number): void {
    const extensions = getExtensionPaths(args);
    expect(extensions).toHaveLength(count);
    expect(extensions[0]).toContain("complete-extension");
    if (count > 1) expect(extensions[1]).toContain("sampling-extension");
  }

  test("sampling-enabled agent spawn includes correct environment variable and both complete and sampling extension args", async () => {
    const agent = makeModelAgent({
      name: "sampling-agent",
      temperature: 0.7,
      topP: 0.9,
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe('{"temperature":0.7,"topP":0.9}');
    expectExtensions(args, 2);
  });

  test("agent with temperature only includes only temperature in environment variable and loads sampling extension", async () => {
    const agent = makeModelAgent({
      name: "temp-only-agent",
      temperature: 0.3,
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe('{"temperature":0.3}');
    expectExtensions(args, 2);
  });

  test("agent with topP only includes only topP in environment variable and loads sampling extension", async () => {
    const agent = makeModelAgent({
      name: "topp-only-agent",
      topP: 0.25,
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe('{"topP":0.25}');
    expectExtensions(args, 2);
  });

  test("agent without sampling values omits sampling env and sampling extension args while still loading the complete extension", async () => {
    const agent = makeModelAgent({
      name: "no-sampling-agent",
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe("");
    expectExtensions(args, 1);
    expect(args.join(" ")).not.toContain("sampling-extension");
  });

  test("concurrent or sequential different agents do not leak sampling values across runs", async () => {
    const samplingAgent = makeModelAgent({
      name: "sampling-agent",
      temperature: 0.5,
    });
    const plainAgent = makeModelAgent({
      name: "plain-agent",
    });

    const run1 = await runCapturedAgentWithParams(samplingAgent);
    const run2 = await runCapturedAgentWithParams(plainAgent);

    expect(run1.envSampling).toBe('{"temperature":0.5}');
    expect(run2.envSampling).toBe("");
  });

  test("no-sampling agent removes inherited parent PI_SAMPLING_PARAMS from child env", async () => {
    process.env["PI_SAMPLING_PARAMS"] = '{"temperature":0.1}';
    try {
      const agent = makeModelAgent({
        name: "no-sampling-agent",
      });
      const { args, envSampling } = await runCapturedAgentWithParams(agent);
      expect(envSampling).toBe("");
      expect(args.join(" ")).not.toContain("sampling-extension");
    } finally {
      delete process.env["PI_SAMPLING_PARAMS"];
    }
  });

  test("concurrent mixed sampling and no-sampling runs are isolated and do not contaminate or leak", async () => {
    process.env["PI_SAMPLING_PARAMS"] = '{"temperature":0.8}';
    try {
      const samplingAgent = makeModelAgent({
        name: "sampling-agent",
        temperature: 0.4,
      });
      const noSamplingAgent = makeModelAgent({
        name: "no-sampling-agent",
      });
      const [run1, run2] = await Promise.all([
        runCapturedAgentWithParams(samplingAgent),
        runCapturedAgentWithParams(noSamplingAgent),
      ]);
      expect(run1.envSampling).toBe('{"temperature":0.4}');
      expect(run2.envSampling).toBe("");
    } finally {
      delete process.env["PI_SAMPLING_PARAMS"];
    }
  });
});

test("runSingleAgent adds sampling extension when agent provides temperature or topP", async () => {
  const agent = makeModelAgent({ temperature: 0.5, topP: 0.9 });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  const extPaths = flagValues(args, "--extension");
  expect(extPaths.length).toBe(2);
  expect(extPaths.some((p) => p.includes("sampling-extension"))).toBe(true);
  expect(extPaths.some((p) => p.includes("complete-extension"))).toBe(true);
});

test("discovery-normalized context true omits --no-context-files from child args", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const agentsDir = path.join(agentDir, "agents");
  await fs.promises.writeFile(
    path.join(agentsDir, "context-true.md"),
    `---
name: context-true
context: true
description: Context true agent
---
Prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const discoveredAgent = discovery.agents.find(
    (a) => a.name === "context-true",
  );
  if (!discoveredAgent) throw new Error("context-true agent not discovered");
  expect(Object.hasOwn(discoveredAgent, "context")).toBe(false);
  expect(discoveredAgent.context).toBeUndefined();
  const args = await captureRunSingleAgentArgs(discoveredAgent, undefined);
  expect(args).not.toContain("--no-context-files");
  expect(args).toContain("--approve");
});

test("runSingleAgent named extensions flow through to child args via runSingleAgent", async () => {
  const { cwd } = await setupTest({
    piScript: CAPTURE_ARGS_PI_SCRIPT,
  });
  const resolvedPath = path.join(
    cwd,
    ".pi",
    "extensions",
    "my-ext",
    "index.js",
  );
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(resolvedPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/my-ext",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/my-ext",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["my-ext"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    const args = await readCapturedArgs(cwd);
    const pkgPath = resolvePackageExtensionPath();
    expect(args).toContain("--no-extensions");
    expect(flagValues(args, "--extension")).toContain(pkgPath);
    const resolvedExt = flagValues(args, "--extension").find(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(resolvedExt).toBeDefined();
    expect(resolvedExt).toContain("my-ext");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent single-file extension resolves by file stem and flows to child args", async () => {
  const { cwd } = await setupTest({
    piScript: CAPTURE_ARGS_PI_SCRIPT,
  });
  const resolvedPath = path.join(cwd, ".pi", "extensions", "helper.ts");
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(
    resolvedPath,
    "export default function setup() {}",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/helper.ts",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/helper.ts",
          scope: "project",
          origin: "top-level",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["helper"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    const args = await readCapturedArgs(cwd);
    const pkgPath = resolvePackageExtensionPath();
    expect(args).toContain("--no-extensions");
    expect(flagValues(args, "--extension")).toContain(pkgPath);
    const resolvedExt = flagValues(args, "--extension").find(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(resolvedExt).toBeDefined();
    expect(resolvedExt).toContain("helper");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent version-pinned npm package extension resolves and flows to child args", async () => {
  const { cwd } = await setupTest({
    piScript: CAPTURE_ARGS_PI_SCRIPT,
  });
  const resolvedPath = path.join(cwd, "node_modules", "helper", "index.js");
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(resolvedPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "node_modules/helper",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:helper@1.2.3",
          scope: "user",
          origin: "package",
        },
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
      },
    ],
    errors: [],
    runtime: {} as never,
  });
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["helper"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    const args = await readCapturedArgs(cwd);
    const pkgPath = resolvePackageExtensionPath();
    expect(args).toContain("--no-extensions");
    expect(flagValues(args, "--extension")).toContain(pkgPath);
    const resolvedExt = flagValues(args, "--extension").find(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(resolvedExt).toBeDefined();
    expect(resolvedExt).toContain("helper");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});
