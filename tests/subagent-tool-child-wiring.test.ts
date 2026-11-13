import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { resolvePackageExtensionPath } from "../src/child/process-utils.js";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import { resetAgentCache } from "../src/index.js";
import { listRunJobs } from "../src/orchestration/run-registry.js";
import { queryRootRunUsage } from "../src/orchestration/usage-ledger.js";
import {
  resetResolvedAgentExtensionPathsCache,
  resetResolvedAgentSkillArgsCache,
} from "../src/shared/resource-resolution.js";
import type {
  SubagentDetails,
  UsageInstanceNode,
} from "../src/shared/types.js";
import type { SendMessageArg } from "./helpers.js";
import {
  CAPTURE_ARGS_PI_SCRIPT,
  CAPTURE_PI_ARGS_SH,
  emitAgentEnd,
  emitMessageEnd,
  flagValues,
  getSubagentTool,
  installFakePi,
  makeAssistantMessage,
  makeBareCtx,
  readCapturedArgs,
  registryFixture,
  requestIdOf,
  runTool,
  setupFakePi,
  setupHooks,
  setupTest,
  shellQuote,
  waitForRunJobsCleared,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

async function createAgentWithExtensions(
  agentDir: string,
  name: string,
  extensionsContent: string | undefined,
): Promise<void> {
  const agentsDir = path.join(agentDir, "agents");
  const frontmatter = [
    `name: ${name}`,
    `description: Extension test agent`,
    `thinking: off`,
  ];
  if (extensionsContent !== undefined) {
    frontmatter.push(`extensions: ${extensionsContent}`);
  }
  const agentMd = `---\n${frontmatter.join("\n")}\n---\nSystem prompt.`;
  await writeFile(path.join(agentsDir, `${name}.md`), agentMd);
  resetAgentCache();
  resetResolvedAgentExtensionPathsCache();
  resetResolvedAgentSkillArgsCache();
}

test("subagent tool captures pi output including usage and model", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"provider":"openai","model":"gpt-4o-mini","usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.001}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await runTool(tool, { agent: "hang", task: "test" }, makeBareCtx(cwd));
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("Outcome: hello");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.usage.input).toBe(10);
  expect(details.results[0]?.finalOutput).toBe("Outcome: hello");
  expect(details.results[0]?.messages).toBeUndefined();
  expect(details.results[0]?.instanceName).toMatch(/^[a-z]+-[a-z]+$/);
  expect(details.results[0]?.usage.contextWindowTokens).toBe(128000);
  expect(details.results[0]?.model).toBe("off");
  const sentMessages2: SendMessageArg[] = [];
  const tool2 = getSubagentTool({
    sendMessage: (msg) => sentMessages2.push(msg),
  });
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  await runTool(
    tool2,
    { agent: "hang", task: "test", debug: true },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages2, 2);
  const debugDetails = sentMessages2.at(-1)?.details as SubagentDetails;
  expect(debugDetails.results[0]?.messages).toHaveLength(1);
  expect(debugDetails.results[0]?.instanceName).toMatch(/^[a-z]+-[a-z]+$/);
});

test("subagent tool lifecycle failure with thinking warning includes warning in parent content", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "think-agent.md"),
    `---
name: think-agent
description: Think agent
---
Prompt`,
  );
  const finalOutput = "Outcome: failed with thinking";
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
  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' ${shellQuote(toolResultEnd)}
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "think-agent", task: "thinking failure" },
    {
      cwd,
      hasUI: false,
      model: { provider: "openai", id: "gpt-4o-mini" },
      modelRegistry: registryFixture([]),
    } as unknown as ExtensionContext,
  );
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain("[thinking]");
  expect(resultText).toContain(finalOutput);
});

test("subagent tool preserves existing model/provider, thinking, skills, extensions, and contracts under both sampling and no-sampling configurations", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();

  const skillDir = path.join(agentDir, "skills", "helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: helper
description: Helper skill
---
Use helper skill.`,
  );

  await writeFile(
    path.join(agentDir, "agents", "sampling-agent.md"),
    `---
name: sampling-agent
description: Sampling agent
skills: helper
temperature: 0.6
top_p: 0.8
---
Sampling agent prompt`,
  );

  await writeFile(
    path.join(agentDir, "agents", "no-sampling-agent.md"),
    `---
name: no-sampling-agent
description: No-sampling agent
skills: helper
---
No-sampling agent prompt`,
  );

  await installFakePi(
    binDir,
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' "$PI_SAMPLING_PARAMS" > env_sampling.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );

  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });

  process.env.PI_SUBAGENT_DEPTH = "1";

  const resSampling = await tool.execute(
    "test-tool-call-1",
    { agent: "sampling-agent", task: "sampling task" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "fake-provider", id: "fake-model" },
      modelRegistry: registryFixture([]),
    } as unknown as ExtensionContext,
  );

  const expectedSamplingWarning =
    'Thinking level "high" support could not be confirmed; requesting as-is (provider: fake-provider, model: fake-model)';
  expect((resSampling.content[0] as TextContent).text).toBe(
    `[thinking] ${expectedSamplingWarning}\n\ndone`,
  );
  const argsSampling = await readCapturedArgs(cwd);
  const promptSampling = await Bun.file(path.join(cwd, "prompt.txt")).text();
  const envSampling = await Bun.file(path.join(cwd, "env_sampling.txt")).text();

  expect(argsSampling.join(" ")).toContain(
    "--provider fake-provider --model fake-model",
  );
  expect(argsSampling.join(" ")).toContain("--thinking high");
  expect(argsSampling.join(" ")).toContain("--no-skills --skill");
  expect(argsSampling.join(" ")).toContain(path.join(skillDir, "SKILL.md"));
  expect(argsSampling.join(" ")).toContain("complete-extension");
  const contractSamplingIdx = argsSampling.indexOf(SUBAGENT_RESULT_CONTRACT);
  expect(argsSampling[contractSamplingIdx + 1]).toBe("Task: sampling task");
  expect(argsSampling[contractSamplingIdx + 1]).not.toContain(
    "Subagent Result Contract",
  );
  const appendsSampling = flagValues(argsSampling, "--append-system-prompt");
  expect(appendsSampling).toHaveLength(2);
  expect(appendsSampling[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appendsSampling.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(promptSampling).toBe("Sampling agent prompt");
  expect((resSampling.details as SubagentDetails).results[0]?.model).toBe(
    "fake-provider ･ fake-model ･ high",
  );
  expect(
    (resSampling.details as SubagentDetails).results[0]?.thinkingWarning,
  ).toBe(expectedSamplingWarning);

  expect(argsSampling.join(" ")).toContain("sampling-extension");
  const samplingExtensionIdx = argsSampling.findIndex((arg) =>
    arg.includes("sampling-extension"),
  );
  expect(samplingExtensionIdx).toBeGreaterThan(-1);
  expect(contractSamplingIdx).toBeGreaterThan(samplingExtensionIdx);
  expect(JSON.parse(envSampling.trim())).toEqual({
    temperature: 0.6,
    topP: 0.8,
  });

  await writeFile(path.join(cwd, "args.txt"), "");
  await writeFile(path.join(cwd, "env_sampling.txt"), "");
  await writeFile(path.join(cwd, "prompt.txt"), "");

  const resNoSampling = await tool.execute(
    "test-tool-call-2",
    { agent: "no-sampling-agent", task: "no-sampling task" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "fake-provider", id: "fake-model" },
      modelRegistry: registryFixture([]),
    } as unknown as ExtensionContext,
  );

  const expectedNoSamplingWarning =
    'Thinking level "high" support could not be confirmed; requesting as-is (provider: fake-provider, model: fake-model)';
  expect((resNoSampling.content[0] as TextContent).text).toBe(
    `[thinking] ${expectedNoSamplingWarning}\n\ndone`,
  );
  const argsNoSampling = await readCapturedArgs(cwd);
  const promptNoSampling = await Bun.file(path.join(cwd, "prompt.txt")).text();
  const envNoSampling = await Bun.file(
    path.join(cwd, "env_sampling.txt"),
  ).text();

  expect(argsNoSampling.join(" ")).toContain(
    "--provider fake-provider --model fake-model",
  );
  expect(argsNoSampling.join(" ")).toContain("--thinking high");
  expect(argsNoSampling.join(" ")).toContain("--no-skills --skill");
  expect(argsNoSampling.join(" ")).toContain(path.join(skillDir, "SKILL.md"));
  expect(argsNoSampling.join(" ")).toContain("complete-extension");
  const contractNoSamplingIdx = argsNoSampling.indexOf(
    SUBAGENT_RESULT_CONTRACT,
  );
  expect(argsNoSampling[contractNoSamplingIdx + 1]).toBe(
    "Task: no-sampling task",
  );
  expect(argsNoSampling[contractNoSamplingIdx + 1]).not.toContain(
    "Subagent Result Contract",
  );
  const appendsNoSampling = flagValues(
    argsNoSampling,
    "--append-system-prompt",
  );
  expect(appendsNoSampling).toHaveLength(2);
  expect(appendsNoSampling[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appendsNoSampling.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(promptNoSampling).toBe("No-sampling agent prompt");
  expect((resNoSampling.details as SubagentDetails).results[0]?.model).toBe(
    "fake-provider ･ fake-model ･ high",
  );
  expect(
    (resNoSampling.details as SubagentDetails).results[0]?.thinkingWarning,
  ).toBe(expectedNoSamplingWarning);

  expect(argsNoSampling.join(" ")).not.toContain("sampling-extension");
  expect(envNoSampling.trim()).toBe("");

  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool preserves recursion depth handling under both sampling and no-sampling configurations", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();

  await writeFile(
    path.join(agentDir, "agents", "sampling-agent.md"),
    `---
name: sampling-agent
description: Sampling agent
temperature: 0.5
---
Sampling agent prompt`,
  );

  await writeFile(
    path.join(agentDir, "agents", "no-sampling-agent.md"),
    `---
name: no-sampling-agent
description: No-sampling agent
---
No-sampling agent prompt`,
  );

  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });

  process.env.PI_SUBAGENT_DEPTH = "5";

  const resSampling = await tool.execute(
    "test-tool-call-1",
    { agent: "sampling-agent", task: "sampling task" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );

  const samplingText = (resSampling.content[0] as TextContent).text;
  expect(samplingText).toStartWith("(failed) ");
  expect(samplingText).toContain("depth");
  const directDetailsSampling = resSampling.details as SubagentDetails;
  expect(directDetailsSampling.results[0]?.exitCode).toBe(1);

  const resNoSampling = await tool.execute(
    "test-tool-call-2",
    { agent: "no-sampling-agent", task: "no-sampling task" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );

  const noSamplingText = (resNoSampling.content[0] as TextContent).text;
  expect(noSamplingText).toStartWith("(failed) ");
  expect(noSamplingText).toContain("depth");
  const directDetailsNoSampling = resNoSampling.details as SubagentDetails;
  expect(directDetailsNoSampling.results[0]?.exitCode).toBe(1);

  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool strips inherited PI_SAMPLING_PARAMS when agent has no sampling overrides", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();

  await writeFile(
    path.join(agentDir, "agents", "no-sampling-agent.md"),
    `---
name: no-sampling-agent
description: No-sampling agent
---
No-sampling agent prompt`,
  );

  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\\n' "$PI_SAMPLING_PARAMS" > env_sampling.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );

  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env["PI_SAMPLING_PARAMS"] = JSON.stringify({
    temperature: 0.99,
    topP: 0.99,
  });

  try {
    const result = await runTool(
      tool,
      { agent: "no-sampling-agent", task: "no-sampling task" },
      makeBareCtx(cwd),
    );

    expect((result.content[0] as TextContent).text).toBe("done");
    const envSampling = await Bun.file(
      path.join(cwd, "env_sampling.txt"),
    ).text();
    expect(envSampling.trim()).toBe("");
    expect(listRunJobs()).toHaveLength(0);
  } finally {
    delete process.env["PI_SAMPLING_PARAMS"];
  }
});

test("subagent context false passes --no-context-files to child alongside approval tools skills model provider thinking prompt complete-extension sampling-extension result-contract", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  const skillDir = path.join(agentDir, "skills", "helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: helper
description: Helper skill
---
Use helper skill.`,
  );
  await writeFile(
    path.join(agentDir, "agents", "context-off-full.md"),
    `---
name: context-off-full
description: Context off with all features
context: false
tools: bash, read
skills: helper
model: gpt-4
provider: openai
thinking: high
temperature: 0.7
top_p: 0.9
---
Full feature prompt.`,
  );
  await installFakePi(
    binDir,
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "off",
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "context-off-full", task: "context test" },
    makeBareCtx(cwd),
  );
  const args = await readCapturedArgs(cwd);
  const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
  expect((result.content[0] as TextContent).text).toContain("done");
  expect(args.join(" ")).toContain("--no-context-files");
  expect(args.join(" ")).toContain("--approve");
  expect(args.join(" ")).toContain("--provider openai");
  expect(args.join(" ")).toContain("--model gpt-4");
  expect(args.join(" ")).toMatch(/--thinking \S+/);
  expect(args.join(" ")).toContain("--tools bash,read,complete");
  expect(args.join(" ")).toContain("--no-skills --skill");
  expect(args.join(" ")).toContain(path.join(skillDir, "SKILL.md"));
  expect(args).toContain("--append-system-prompt");
  expect(args).toContain("--extension");
  const contractIdx = args.indexOf(SUBAGENT_RESULT_CONTRACT);
  expect(args[contractIdx + 1]).toBe("Task: context test");
  expect(args[contractIdx + 1]).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(args.join(" ")).toContain("--no-themes");
  expect(args.join(" ")).toContain("--no-prompt-templates");
  expect(promptText).toBe("Full feature prompt.");
  expect((args.join(" ").match(/--no-context-files/g) ?? []).length).toBe(1);
  expect((result.details as SubagentDetails).results[0]?.agentSource).toBe(
    "user",
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent context false does not leak --no-context-files to subsequent context-absent invocation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "ctx-off.md"),
    `---
name: ctx-off
description: Context off agent
context: false
---
Context off prompt.`,
  );
  await installFakePi(binDir, CAPTURE_ARGS_PI_SCRIPT);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const ctxOffResult = await tool.execute(
    "run-1",
    { agent: "ctx-off", task: "first" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const argsOff = await readCapturedArgs(cwd);
  expect((ctxOffResult.content[0] as TextContent).text).toBe("done");
  expect(argsOff).toContain("--no-context-files");
  const hangResult = await tool.execute(
    "run-2",
    { agent: "hang", task: "second" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const argsHang = await readCapturedArgs(cwd);
  expect((hangResult.content[0] as TextContent).text).toBe("done");
  expect(argsHang).not.toContain("--no-context-files");
  expect(argsHang).toContain("--approve");
  expect(argsHang).toContain("Task: second");
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent skills false passes --no-skills without skill paths to child and does not trigger skill resolution", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  const skillDir = path.join(agentDir, "skills", "nonexistent");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: nonexistent
description: Should not be loaded
---
Ghost skill.`,
  );
  await writeFile(
    path.join(agentDir, "agents", "skills-off.md"),
    `---
name: skills-off
description: Skills disabled agent
skills: false
---
No skills prompt.`,
  );
  await installFakePi(
    binDir,
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd()}
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await runTool(
    tool,
    { agent: "skills-off", task: "skills off test" },
    makeBareCtx(cwd),
  );
  const args = await readCapturedArgs(cwd);
  expect((result.content[0] as TextContent).text).toBe("done");
  expect(args.join(" ")).toContain("--no-skills");
  expect(args.join(" ")).not.toContain("--skill");
  expect(args.join(" ")).not.toContain("nonexistent");
  expect(args.join(" ")).toContain("--no-themes");
  expect(args.join(" ")).toContain("--no-prompt-templates");
  expect(args.join(" ")).toContain("--approve");
  expect(args.at(-1)).toBe("Task: skills off test");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect((result.details as SubagentDetails).results[0]?.agentSource).toBe(
    "user",
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent skills false does not leak --no-skills to subsequent skills-absent invocation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "skills-off-2.md"),
    `---
name: skills-off-2
description: Skills disabled agent 2
skills: false
---
No skills prompt.`,
  );
  await installFakePi(binDir, CAPTURE_ARGS_PI_SCRIPT);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const skillsOffResult = await tool.execute(
    "run-1",
    { agent: "skills-off-2", task: "first" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const argsOff = await readCapturedArgs(cwd);
  expect((skillsOffResult.content[0] as TextContent).text).toBe("done");
  expect(argsOff).toContain("--no-skills");
  const hangResult = await tool.execute(
    "run-2",
    { agent: "hang", task: "second" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const argsHang = await readCapturedArgs(cwd);
  expect((hangResult.content[0] as TextContent).text).toBe("done");
  expect(argsHang).not.toContain("--no-skills");
  expect(argsHang).toContain("--approve");
  expect(argsHang).toContain("Task: second");
  expect(listRunJobs()).toHaveLength(0);
});

test("tool path disabled extensions at depth 0 starts job and child receives package index", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: CAPTURE_ARGS_PI_SCRIPT,
  });
  await createAgentWithExtensions(agentDir, "depth-zero-ext", "[]");
  process.env.PI_SUBAGENT_DEPTH = "0";
  const result = await runTool(
    tool,
    { agent: "depth-zero-ext", task: "depth 0" },
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toContain("started");
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
  const args = await readCapturedArgs(cwd);
  expect(args).toContain("--no-extensions");
  expect(flagValues(args, "--extension")).toContain(
    resolvePackageExtensionPath(),
  );
  await waitForRunJobsCleared();
  expect(listRunJobs()).toHaveLength(0);
});

test("tool path named extensions resolves and passes to child with first-seen order", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
${emitAgentEnd([])}
exit 0
`,
  });
  const extDir = path.join(agentDir, "extensions");
  const extAPath = path.join(extDir, "ext-a", "index.js");
  const extBPath = path.join(extDir, "ext-b", "index.js");
  const extCPath = path.join(extDir, "ext-c", "index.js");
  await fs.promises.mkdir(path.dirname(extAPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(extBPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(extCPath), { recursive: true });
  await fs.promises.writeFile(extAPath, "module.exports = function() {}");
  await fs.promises.writeFile(extBPath, "module.exports = function() {}");
  await fs.promises.writeFile(extCPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: "extensions/ext-c",
          resolvedPath: extCPath,
          sourceInfo: {
            path: extCPath,
            source: "extensions/ext-c",
            scope: "user",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
        {
          path: "extensions/ext-b",
          resolvedPath: extBPath,
          sourceInfo: {
            path: extBPath,
            source: "extensions/ext-b",
            scope: "user",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
        {
          path: "extensions/ext-a",
          resolvedPath: extAPath,
          sourceInfo: {
            path: extAPath,
            source: "extensions/ext-a",
            scope: "user",
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
    };
  };
  await createAgentWithExtensions(
    agentDir,
    "named-ext",
    '"ext-c, ext-a, ext-b"',
  );
  try {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const result = await runTool(
      tool,
      { agent: "named-ext", task: "named extensions task" },
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    expect((result.content[0] as TextContent).text).toBe("done");
    const args = await readCapturedArgs(cwd);
    expect(args).toContain("--no-extensions");
    const pkgPath = resolvePackageExtensionPath();
    const extFlags = flagValues(args, "--extension");
    expect(extFlags).toContain(pkgPath);
    const namedFlags = extFlags.filter(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(namedFlags).toEqual([extCPath, extAPath, extBPath]);
    expect(args.at(-1)).toBe("Task: named extensions task");
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toHaveLength(2);
    expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("tool path warm cache preserves named extension order across consecutive invocations", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: CAPTURE_ARGS_PI_SCRIPT,
  });
  const extDir = path.join(agentDir, "extensions");
  const extAPath = path.join(extDir, "warm-a", "index.js");
  const extBPath = path.join(extDir, "warm-b", "index.js");
  await fs.promises.mkdir(path.dirname(extAPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(extBPath), { recursive: true });
  await fs.promises.writeFile(extAPath, "module.exports = function() {}");
  await fs.promises.writeFile(extBPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  const originalReload = DefaultResourceLoader.prototype.reload;
  let reloadCalls = 0;
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: "extensions/warm-a",
          resolvedPath: extAPath,
          sourceInfo: {
            path: extAPath,
            source: "extensions/warm-a",
            scope: "user",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
        {
          path: "extensions/warm-b",
          resolvedPath: extBPath,
          sourceInfo: {
            path: extBPath,
            source: "extensions/warm-b",
            scope: "user",
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
    };
  };
  DefaultResourceLoader.prototype.reload = async function trackReload() {
    reloadCalls += 1;
    return originalReload.call(this);
  };
  await createAgentWithExtensions(agentDir, "warm-ext", '"warm-b, warm-a"');
  const namedExtensions = (args: string[]) => {
    const pkgPath = resolvePackageExtensionPath();
    return flagValues(args, "--extension").filter(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
  };
  try {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const result1 = await runTool(
      tool,
      { agent: "warm-ext", task: "warm first" },
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    expect((result1.content[0] as TextContent).text).toBe("done");
    const namedFirst = namedExtensions(await readCapturedArgs(cwd));
    expect(namedFirst).toEqual([extBPath, extAPath]);
    expect(reloadCalls).toBeGreaterThanOrEqual(1);
    reloadCalls = 0;
    sentMessages.length = 0;
    const result2 = await runTool(
      tool,
      { agent: "warm-ext", task: "warm second" },
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    expect((result2.content[0] as TextContent).text).toBe("done");
    const namedSecond = namedExtensions(await readCapturedArgs(cwd));
    expect(namedSecond).toEqual(namedFirst);
    expect(reloadCalls).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("tool path unknown extension names return completed error with sorted available names and no child spawn", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
echo "should not spawn" > spawn-marker.txt
exit 0
`,
  });
  const extDir = path.join(cwd, ".pi", "extensions");
  const alphaPath = path.join(extDir, "alpha-ext", "index.js");
  const zebraPath = path.join(extDir, "zebra-ext", "index.js");
  await fs.promises.mkdir(path.dirname(alphaPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(zebraPath), { recursive: true });
  await fs.promises.writeFile(alphaPath, "module.exports = function() {}");
  await fs.promises.writeFile(zebraPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: ".pi/extensions/zebra-ext",
          resolvedPath: zebraPath,
          sourceInfo: {
            path: zebraPath,
            source: ".pi/extensions/zebra-ext",
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
        {
          path: ".pi/extensions/alpha-ext",
          resolvedPath: alphaPath,
          sourceInfo: {
            path: alphaPath,
            source: ".pi/extensions/alpha-ext",
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
    };
  };
  await createAgentWithExtensions(
    agentDir,
    "bad-ext",
    '"nonexistent, also-missing"',
  );
  try {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const result = await runTool(
      tool,
      { agent: "bad-ext", task: "unknown extensions task" },
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    const resultText = (result.content[0] as TextContent).text;
    expect(resultText).toStartWith("(failed) ");
    expect(resultText).toContain('"nonexistent"');
    expect(resultText).toContain('"also-missing"');
    expect(resultText).toContain("Available extensions:");
    expect(resultText).toContain("alpha-ext");
    expect(resultText).toContain("zebra-ext");
    const details = result.details as SubagentDetails;
    expect(details.results[0]?.exitCode).toBe(1);
    expect(fs.existsSync(path.join(cwd, "spawn-marker.txt"))).toBe(false);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("subagent tool replace_prompt true uses --system-prompt and keeps contract last", async () => {
  const { tool, cwd, agentDir } = await setupTest({
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
${emitMessageEnd(makeAssistantMessage("done"))}
${emitAgentEnd([])}
exit 0
`,
  });
  await writeFile(
    path.join(agentDir, "agents", "replace-agent.md"),
    `---
name: replace-agent
description: Replace prompt agent
replace_prompt: true
---
Replacement body prompt.
`,
  );
  await runTool(
    tool,
    { agent: "replace-agent", task: "replace task" },
    makeBareCtx(cwd),
  );
  await waitForRunJobsCleared();
  const args = await readCapturedArgs(cwd);
  expect(flagValues(args, "--system-prompt")).toHaveLength(1);
  expect(flagValues(args, "--append-system-prompt")).toEqual([
    SUBAGENT_RESULT_CONTRACT,
  ]);
  const systemIdx = args.indexOf("--system-prompt");
  const contractIdx = args.indexOf(SUBAGENT_RESULT_CONTRACT);
  expect(systemIdx).toBeGreaterThan(-1);
  expect(contractIdx).toBeGreaterThan(systemIdx);
  expect(args.at(-1)).toBe("Task: replace task");
  const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
  expect(promptText).toBe("Replacement body prompt.");
});

test("cross-process nested subagent delivers tool_execution_update and toolResult usageTrees with stable spawner ordinals and self-only result usage", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const childRunnerPath = path.join(cwd, "nested-child-runner.ts");
  const orchestratorPath = path.resolve(
    "src/orchestration/subagent-orchestrator.ts",
  );
  const processPath = path.resolve("src/child/process.ts");
  await writeFile(
    childRunnerPath,
    `import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setDefaultSleepInhibitorAcquirer } from ${JSON.stringify(processPath)};
import { startSubagentJob, formatSubagentToolResult } from ${JSON.stringify(orchestratorPath)};

process.argv[1] = "not-pi";
setDefaultSleepInhibitorAcquirer(async () => ({ async release() {} }));

const fakePi = {
  getThinkingLevel: () => "off",
  sendMessage: () => {},
} as unknown as ExtensionAPI;

const ctx = {
  cwd: process.cwd(),
  hasUI: false,
  modelRegistry: { find: () => undefined },
} as unknown as ExtensionContext;

async function runGrandchild(toolCallId: string, task: string) {
  const res = await startSubagentJob(
    fakePi,
    ctx,
    { agent: "hang", task },
    undefined,
    (partial) => {
      process.stdout.write(
        JSON.stringify({
          type: "tool_execution_update",
          toolCallId,
          toolName: "subagent",
          args: { agent: "hang", task },
          partialResult: partial,
        }) + "\\n",
      );
    },
  );
  const toolResult = formatSubagentToolResult("hang", res);
  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "subagent",
        content: toolResult.content,
        details: toolResult.details,
        isError: false,
        timestamp: Date.now(),
      },
    }) + "\\n",
  );
}

await runGrandchild("gc-1", "first grandchild");
await runGrandchild("gc-2", "second grandchild");
`,
  );

  await installFakePi(
    binDir,
    `#!/bin/sh
if [ "$PI_SUBAGENT_DEPTH" = "1" ]; then
  printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"spawning children"}],"usage":{"input":11,"output":4,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"total":0.03}}}}'
  ${shellQuote(process.execPath)} run ${shellQuote(childRunnerPath)}
  printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"all done"}],"usage":{"input":9,"output":6,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"total":0.02}}}}'
  ${emitAgentEnd()}
  exit 0
fi
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"leaf done"}],"usage":{"input":7,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":10,"cost":{"total":0.01}}}}'
${emitAgentEnd()}
exit 0
`,
  );

  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "0";
  const started = await runTool(
    tool,
    { agent: "hang", task: "nested parent" },
    makeBareCtx(cwd),
  );
  expect((started.content[0] as TextContent).text).toContain("started");

  await waitForSentMessageCount(sentMessages, 2);
  await waitForRunJobsCleared();

  const requestId = requestIdOf(sentMessages);
  const terminalMsg = sentMessages.at(-1);
  expect(terminalMsg?.content).toBe("all done");
  const details = terminalMsg?.details as SubagentDetails;
  const selfResult = details.results[0];
  expect(selfResult?.usage.input).toBe(20);
  expect(selfResult?.usage.output).toBe(10);
  expect(selfResult?.usage.turns).toBe(2);
  expect(selfResult?.usage.cost).toBeCloseTo(0.05, 10);

  const tree = details.usageTree;
  expect(tree?.id).toBe(requestId);
  expect(tree?.ordinal).toBe(1);
  expect(tree?.status).toBe("success");
  expect(tree?.children).toHaveLength(2);
  expect(tree?.children[0]?.ordinal).toBe(1);
  expect(tree?.children[0]?.status).toBe("success");
  expect(tree?.children[0]?.usage.input).toBe(7);
  expect(tree?.children[1]?.ordinal).toBe(2);
  expect(tree?.children[1]?.status).toBe("success");
  expect(tree?.children[1]?.usage.input).toBe(7);
  expect(tree?.children[0]?.id).not.toBe(tree?.children[1]?.id);

  const rollup = queryRootRunUsage(requestId)?.rollup;
  expect(rollup?.instances).toBe(3);
  expect(rollup?.usage.input).toBe(34);
  expect(rollup?.usage.output).toBe(16);
  expect(rollup?.usage.cost).toBeCloseTo(0.07, 10);
});

test("tool_result_end and agent_end message replay deliver subagent usageTrees idempotently without expanding debug fields", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const grandchildTree: UsageInstanceNode = {
    id: "gc-replay-1",
    agent: "worker",
    instanceName: "crisp-teal",
    ordinal: 2,
    startedAt: 1_500,
    status: "success",
    durationMs: 90,
    usage: {
      input: 15,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.04,
      turns: 1,
    },
    children: [],
  };
  const toolResultMsg = {
    role: "toolResult",
    toolCallId: "tc-sub-replay",
    toolName: "subagent",
    content: [{ type: "text", text: "child output" }],
    details: {
      mode: "single",
      agentScope: "both",
      projectAgentsDir: null,
      results: [
        {
          agent: "worker",
          instanceName: "crisp-teal",
          agentSource: "user",
          task: "secret-task",
          exitCode: 0,
          finalOutput: "child output",
          stderr: "secret-stderr",
          usage: {
            input: 15,
            output: 5,
            cacheRead: 2,
            cacheWrite: 1,
            cost: 0.04,
            contextTokens: 20,
            turns: 1,
          },
        },
      ],
      usageTree: grandchildTree,
    },
    isError: false,
    timestamp: 2_000,
  };
  const finalAssistantMsg = makeAssistantMessage("finished replay", {
    usage: {
      input: 8,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { total: 0.01 },
    },
  });

  await installFakePi(
    binDir,
    `#!/bin/sh
printf '%s\\n' ${shellQuote(JSON.stringify({ type: "tool_result_end", message: toolResultMsg }))}
printf '%s\\n' ${shellQuote(JSON.stringify({ type: "message_end", message: finalAssistantMsg }))}
${emitAgentEnd([toolResultMsg, finalAssistantMsg])}
exit 0
`,
  );

  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  process.env.PI_SUBAGENT_DEPTH = "1";
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const result = await runTool(
    tool,
    { agent: "hang", task: "parent secret", debug: true },
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);

  expect((result.content[0] as TextContent).text).toBe("finished replay");
  const details = result.details as SubagentDetails;
  const selfResult = details.results[0];
  expect(selfResult?.usage.input).toBe(8);
  expect(selfResult?.messages).toBeDefined();

  const tree = details.usageTree;
  expect(tree?.children).toHaveLength(1);
  expect(tree?.children[0]?.id).toBe("gc-replay-1");
  expect(tree?.children[0]?.ordinal).toBe(2);
  expect(Object.keys(tree ?? {})).not.toContain("messages");
  expect(Object.keys(tree ?? {})).not.toContain("stderr");
  expect(Object.keys(tree ?? {})).not.toContain("task");
  expect(Object.keys(tree?.children[0] ?? {})).not.toContain("task");
  expect(Object.keys(tree?.children[0] ?? {})).not.toContain("stderr");
});
