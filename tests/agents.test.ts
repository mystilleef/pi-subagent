import { expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentConfig,
  discoverAgentsAsync,
  formatAgentList,
  readMarkdownDirWithStatusAsync,
} from "../src/agent/agents.js";
import { setupFakePi } from "./helpers.js";

async function discoverAgent(
  yamlBody: string,
  agentName: string,
): ReturnType<typeof discoverAgentsAsync> {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(path.join(userDir, `${agentName}.md`), yamlBody);
  return discoverAgentsAsync(cwd, "user");
}

async function withCapturedWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("reachability gate: valid markdown produces agent config through discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "valid.md"),
    `---
name: valid-agent
description: A valid agent
tools: bash, read
skills: helper, reviewer
thinking: medium
---
Valid agent prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "valid-agent");
  expect(agent).toBeDefined();
  expect(agent).toMatchObject({
    name: "valid-agent",
    description: "A valid agent",
    tools: ["bash", "read"],
    skills: ["helper", "reviewer"],
    thinking: "medium",
    model: undefined,
    provider: undefined,
    systemPrompt: "Valid agent prompt.",
    source: "user",
    filePath: path.join(userDir, "valid.md"),
  });
});

test("parse model and provider frontmatter without changing existing fields", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "model-provider.md"),
    `---
name: model-provider
provider: anthropic
description: Model provider agent
tools: bash, read
skills: helper, reviewer
model: claude-sonnet-4
thinking: high
---
Model provider prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "model-provider");
  expect(agent).toMatchObject({
    name: "model-provider",
    description: "Model provider agent",
    tools: ["bash", "read"],
    skills: ["helper", "reviewer"],
    thinking: "high",
    model: "claude-sonnet-4",
    provider: "anthropic",
    systemPrompt: "Model provider prompt.",
    source: "user",
    filePath: path.join(userDir, "model-provider.md"),
  });
});

test("trim model and provider frontmatter before discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "trimmed-model-provider.md"),
    `---
name: trimmed-model-provider
description: Trimmed model provider
model: "  claude-sonnet-4  "
provider: "  anthropic  "
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find(
    (a) => a.name === "trimmed-model-provider",
  );
  expect(agent?.model).toBe("claude-sonnet-4");
  expect(agent?.provider).toBe("anthropic");
});

test("parse model-only frontmatter with undefined provider", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "model-only.md"),
    `---
name: model-only
description: Model only
model: gpt-5
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "model-only");
  expect(agent?.model).toBe("gpt-5");
  expect(agent?.provider).toBeUndefined();
});

test("blank provider with model frontmatter normalizes to model-only discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "blank-provider-model.md"),
    `---
name: blank-provider-model
description: Blank provider with model
model: gpt-5
provider: "   "
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "blank-provider-model");
  expect(agent?.model).toBe("gpt-5");
  expect(agent?.provider).toBeUndefined();
});

test("provider with whitespace-only model is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "provider-blank-model.md"),
    `---
name: provider-blank-model
description: Provider with blank model
provider: openai
model: "   "
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === "provider-blank-model"),
  ).toBeUndefined();
});

test("parse provider-only frontmatter is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "provider-only.md"),
    `---
name: provider-only
description: Provider only
provider: openai
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === "provider-only"),
  ).toBeUndefined();
});

test("provider-only with empty model string is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "provider-only-empty-model.md"),
    `---
name: provider-only-empty-model
description: Provider only with empty model
provider: openai
model: ""
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === "provider-only-empty-model"),
  ).toBeUndefined();
});

test("blank model and provider strings normalize to undefined", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "blank-model-provider.md"),
    `---
name: blank-model-provider
description: Blank model provider
model: ""
provider: "   "
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "blank-model-provider");
  expect(agent?.model).toBeUndefined();
  expect(agent?.provider).toBeUndefined();
});

test("bare model: and provider: with null values normalize to undefined", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "bare-null.md"),
    `---
name: bare-null
description: Bare null values
model:
provider:
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "bare-null");
  expect(agent).toBeDefined();
  expect(agent?.model).toBeUndefined();
  expect(agent?.provider).toBeUndefined();
});

test("non-string model field is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "bad-model.md"),
    `---
name: bad-model
description: Bad model
model: 123
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(discovery.agents.find((a) => a.name === "bad-model")).toBeUndefined();
});

test("non-string provider field is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "bad-provider.md"),
    `---
name: bad-provider
description: Bad provider
provider:
  - openai
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === "bad-provider"),
  ).toBeUndefined();
});

test("malformed frontmatter that throws is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  // YAML that causes parseFrontmatter to throw (unterminated flow sequence)
  await writeFile(
    path.join(userDir, "throwing.md"),
    `---
name: [unterminated
description: test
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === "unterminated"),
  ).toBeUndefined();
});

test("non-object frontmatter (array) is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "array.md"),
    `---
- item1
- item2
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  // Array frontmatter should be rejected
  expect(discovery.agents).toHaveLength(1); // only the default "hang" agent
});

test("non-object frontmatter (null) is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "null.md"),
    `---
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  // Null frontmatter should be rejected
  expect(discovery.agents).toHaveLength(1); // only the default "hang" agent
});

test("missing required name field is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "no-name.md"),
    `---
description: Missing name
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.description === "Missing name"),
  ).toBeUndefined();
});

test("missing required description field is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "no-description.md"),
    `---
name: no-description
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === "no-description"),
  ).toBeUndefined();
});

test("non-string tools field is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "bad-tools.md"),
    `---
name: bad-tools
description: Bad tools
tools:
  - bash
  - read
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(discovery.agents.find((a) => a.name === "bad-tools")).toBeUndefined();
});

test("non-string skills field is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "bad-skills.md"),
    `---
name: bad-skills
description: Bad skills
skills:
  - helper
  - reviewer
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(discovery.agents.find((a) => a.name === "bad-skills")).toBeUndefined();
});

test("non-string thinking field is rejected from discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "bad-thinking.md"),
    `---
name: bad-thinking
description: Bad thinking
thinking: 123
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === "bad-thinking"),
  ).toBeUndefined();
});

test("empty skills string produces empty array in discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "empty-skills.md"),
    `---
name: empty-skills
description: Empty skills
skills: 
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "empty-skills");
  expect(agent).toBeDefined();
  expect(agent?.skills).toEqual([]);
});

test("absent skills field produces undefined in discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "no-skills.md"),
    `---
name: no-skills
description: No skills field
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "no-skills");
  expect(agent).toBeDefined();
  expect(agent?.skills).toBeUndefined();
});

test("invalid thinking value is dropped in discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "invalid-thinking.md"),
    `---
name: invalid-thinking
description: Invalid thinking
thinking: invalid-value
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "invalid-thinking");
  expect(agent).toBeDefined();
  expect(agent?.thinking).toBeUndefined();
});

test("thinking values are normalized to lowercase in discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "uppercase-thinking.md"),
    `---
name: uppercase-thinking
description: Uppercase thinking
thinking: HIGH
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "uppercase-thinking");
  expect(agent).toBeDefined();
  expect(agent?.thinking).toBe("high");
});

test("symlinked markdown files are discovered", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  const targetPath = path.join(userDir, "target.txt");
  const symlinkPath = path.join(userDir, "symlinked.md");
  await writeFile(
    targetPath,
    `---
name: symlinked
description: Symlinked agent
tools: bash
thinking: low
---
Symlinked prompt.`,
  );
  await symlink(targetPath, symlinkPath);
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "symlinked");
  expect(agent).toBeDefined();
  expect(agent).toMatchObject({
    name: "symlinked",
    description: "Symlinked agent",
    tools: ["bash"],
    thinking: "low",
    systemPrompt: "Symlinked prompt.",
    source: "user",
    filePath: symlinkPath,
  });
});

test("broken symlinked markdown entries are skipped during discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  const brokenSymlinkPath = path.join(userDir, "broken.md");
  await symlink(path.join(userDir, "missing-target.md"), brokenSymlinkPath);
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(discovery.scopes.user.markdownFiles).toContain("broken.md");
  expect(
    discovery.agents.find((a) => a.filePath === brokenSymlinkPath),
  ).toBeUndefined();
});

test("non-markdown files are ignored in discovery", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "agent.txt"),
    `---
name: text-agent
description: Text file agent
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(discovery.agents.find((a) => a.name === "text-agent")).toBeUndefined();
  expect(discovery.scopes.user.markdownFiles).not.toContain("agent.txt");
});

test("readMarkdownDirWithStatusAsync reports missing directories", async () => {
  const { agentDir } = await setupFakePi();
  const listing = await readMarkdownDirWithStatusAsync(
    path.join(agentDir, "missing-agents"),
  );
  expect(listing).toEqual({ entries: [], ok: false });
});

test("formatAgentList formats empty and truncated lists", () => {
  const agents: AgentConfig[] = [
    {
      name: "alpha",
      description: "First agent",
      systemPrompt: "Prompt",
      source: "user",
      filePath: "alpha.md",
    },
    {
      name: "beta",
      description: "Second agent",
      systemPrompt: "Prompt",
      source: "project",
      filePath: "beta.md",
    },
    {
      name: "gamma",
      description: "Third agent",
      systemPrompt: "Prompt",
      source: "user",
      filePath: "gamma.md",
    },
  ];
  expect(formatAgentList([], 2)).toEqual({ text: "none", remaining: 0 });
  expect(formatAgentList(agents, 2)).toEqual({
    text: "alpha (user): First agent; beta (project): Second agent",
    remaining: 1,
  });
});

test("parse valid temperature and top_p sampling values", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "valid-sampling.md"),
    `---
name: valid-sampling
description: Valid sampling agent
temperature: 0.5
top_p: 0.9
---
Prompt`,
  );
  await writeFile(
    path.join(userDir, "valid-sampling-bounds.md"),
    `---
name: valid-sampling-bounds
description: Valid sampling agent at bounds
temperature: 0
top_p: 1
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent1 = discovery.agents.find((a) => a.name === "valid-sampling");
  expect(agent1?.temperature).toBe(0.5);
  expect(agent1?.topP).toBe(0.9);
  const agent2 = discovery.agents.find(
    (a) => a.name === "valid-sampling-bounds",
  );
  expect(agent2?.temperature).toBe(0);
  expect(agent2?.topP).toBe(1);
});

test("ignore invalid sampling fields, emit warning, and leave only that field absent", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "invalid-sampling-string.md"),
    `---
name: invalid-sampling-string
description: Invalid sampling string
temperature: "0.5"
top_p: "0.9"
---
Prompt`,
  );
  await writeFile(
    path.join(userDir, "invalid-sampling-out-of-range.md"),
    `---
name: invalid-sampling-out-of-range
description: Invalid sampling out of range
temperature: 1.5
top_p: -0.1
---
Prompt`,
  );
  await writeFile(
    path.join(userDir, "invalid-sampling-nan.md"),
    `---
name: invalid-sampling-nan
description: Invalid sampling NaN
temperature: .nan
top_p: .inf
---
Prompt`,
  );
  const { result: discovery, warnings } = await withCapturedWarnings(() =>
    discoverAgentsAsync(cwd, "user"),
  );
  const agent1 = discovery.agents.find(
    (a) => a.name === "invalid-sampling-string",
  );
  expect(agent1).toBeDefined();
  expect(agent1?.temperature).toBeUndefined();
  expect(agent1?.topP).toBeUndefined();
  const agent2 = discovery.agents.find(
    (a) => a.name === "invalid-sampling-out-of-range",
  );
  expect(agent2).toBeDefined();
  expect(agent2?.temperature).toBeUndefined();
  expect(agent2?.topP).toBeUndefined();
  const agent3 = discovery.agents.find(
    (a) => a.name === "invalid-sampling-nan",
  );
  expect(agent3).toBeDefined();
  expect(agent3?.temperature).toBeUndefined();
  expect(agent3?.topP).toBeUndefined();
  expect(
    warnings.some(
      (w) => w.includes("invalid-sampling-string") && w.includes("temperature"),
    ),
  ).toBe(true);
  expect(
    warnings.some(
      (w) => w.includes("invalid-sampling-string") && w.includes("top_p"),
    ),
  ).toBe(true);
  expect(
    warnings.some(
      (w) =>
        w.includes("invalid-sampling-out-of-range") &&
        w.includes("temperature"),
    ),
  ).toBe(true);
  expect(
    warnings.some(
      (w) => w.includes("invalid-sampling-out-of-range") && w.includes("top_p"),
    ),
  ).toBe(true);
  expect(
    warnings.some(
      (w) => w.includes("invalid-sampling-nan") && w.includes("temperature"),
    ),
  ).toBe(true);
  expect(
    warnings.some(
      (w) => w.includes("invalid-sampling-nan") && w.includes("top_p"),
    ),
  ).toBe(true);
});

test("agents without sampling frontmatter match current discovery behavior", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "legacy-agent.md"),
    `---
name: legacy-agent
description: Legacy agent without sampling fields
tools: bash
skills: helper
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "legacy-agent");
  expect(agent).toBeDefined();
  expect(agent?.temperature).toBeUndefined();
  expect(agent?.topP).toBeUndefined();
  expect(agent?.tools).toEqual(["bash"]);
  expect(agent?.skills).toEqual(["helper"]);
});

test("own-property omission of sampling fields when invalid or absent", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "only-temp.md"),
    `---
name: only-temp
description: Only temperature
temperature: 0.5
---
Prompt`,
  );
  await writeFile(
    path.join(userDir, "only-top-p.md"),
    `---
name: only-top-p
description: Only top_p
top_p: 0.8
---
Prompt`,
  );
  await writeFile(
    path.join(userDir, "no-sampling.md"),
    `---
name: no-sampling
description: No sampling
---
Prompt`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const tempAgent = discovery.agents.find((a) => a.name === "only-temp");
  expect(tempAgent).toBeDefined();
  if (tempAgent) {
    expect(Object.hasOwn(tempAgent, "temperature")).toBe(true);
    expect(Object.hasOwn(tempAgent, "topP")).toBe(false);
  }

  const topPAgent = discovery.agents.find((a) => a.name === "only-top-p");
  expect(topPAgent).toBeDefined();
  if (topPAgent) {
    expect(Object.hasOwn(topPAgent, "temperature")).toBe(false);
    expect(Object.hasOwn(topPAgent, "topP")).toBe(true);
  }

  const noSamplingAgent = discovery.agents.find(
    (a) => a.name === "no-sampling",
  );
  expect(noSamplingAgent).toBeDefined();
  if (noSamplingAgent) {
    expect(Object.hasOwn(noSamplingAgent, "temperature")).toBe(false);
    expect(Object.hasOwn(noSamplingAgent, "topP")).toBe(false);
  }
});

test("own-property omission and sibling retention for mixed-validity frontmatter", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "invalid-temp-valid-top-p.md"),
    `---
name: invalid-temp-valid-top-p
description: Invalid temperature and valid top_p
temperature: 1.5
top_p: 0.8
---
Prompt`,
  );
  await writeFile(
    path.join(userDir, "valid-temp-invalid-top-p.md"),
    `---
name: valid-temp-invalid-top-p
description: Valid temperature and invalid top_p
temperature: 0.5
top_p: -0.1
---
Prompt`,
  );
  const { result: discovery, warnings } = await withCapturedWarnings(() =>
    discoverAgentsAsync(cwd, "user"),
  );
  const agent1 = discovery.agents.find(
    (a) => a.name === "invalid-temp-valid-top-p",
  );
  expect(agent1).toBeDefined();
  if (agent1) {
    expect(Object.hasOwn(agent1, "temperature")).toBe(false);
    expect(Object.hasOwn(agent1, "topP")).toBe(true);
    expect(agent1.temperature).toBeUndefined();
    expect(agent1.topP).toBe(0.8);
  }
  const agent2 = discovery.agents.find(
    (a) => a.name === "valid-temp-invalid-top-p",
  );
  expect(agent2).toBeDefined();
  if (agent2) {
    expect(Object.hasOwn(agent2, "temperature")).toBe(true);
    expect(Object.hasOwn(agent2, "topP")).toBe(false);
    expect(agent2.temperature).toBe(0.5);
    expect(agent2.topP).toBeUndefined();
  }
  expect(
    warnings.some(
      (w) =>
        w.includes("invalid-temp-valid-top-p") && w.includes("temperature"),
    ),
  ).toBe(true);
  expect(
    warnings.some(
      (w) => w.includes("valid-temp-invalid-top-p") && w.includes("top_p"),
    ),
  ).toBe(true);
});

test("context false discovery stores agent.context === false as own property", async () => {
  const discovery = await discoverAgent(
    `---
name: context-false
description: Context false agent
context: false
---
Prompt`,
    "context-false",
  );
  const agent = discovery.agents.find((a) => a.name === "context-false");
  expect(agent).toBeDefined();
  expect(agent?.context).toBe(false);
  if (agent) expect(Object.hasOwn(agent, "context")).toBe(true);
});

test("context true discovery omits own context property", async () => {
  const discovery = await discoverAgent(
    `---
name: context-true
description: Context true agent
context: true
---
Prompt`,
    "context-true",
  );
  const agent = discovery.agents.find((a) => a.name === "context-true");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "context")).toBe(false);
    expect(agent.context).toBeUndefined();
  }
});

test("omitted context field discovery omits own context property", async () => {
  const discovery = await discoverAgent(
    `---
name: no-context
description: No context field
---
Prompt`,
    "no-context",
  );
  const agent = discovery.agents.find((a) => a.name === "no-context");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "context")).toBe(false);
    expect(agent.context).toBeUndefined();
  }
});

test("non-boolean context string rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: context-string
description: Context string agent
context: "false"
---
Prompt`,
    "context-string",
  );
  expect(
    discovery.agents.find((a) => a.name === "context-string"),
  ).toBeUndefined();
});

test("non-boolean context number rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: context-number
description: Context number agent
context: 0
---
Prompt`,
    "context-number",
  );
  expect(
    discovery.agents.find((a) => a.name === "context-number"),
  ).toBeUndefined();
});

test("non-boolean context array rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: context-array
description: Context array agent
context:
  - false
---
Prompt`,
    "context-array",
  );
  expect(
    discovery.agents.find((a) => a.name === "context-array"),
  ).toBeUndefined();
});

test("non-boolean context object rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: context-object
description: Context object agent
context:
  enabled: false
---
Prompt`,
    "context-object",
  );
  expect(
    discovery.agents.find((a) => a.name === "context-object"),
  ).toBeUndefined();
});

test("bare YAML context null rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: context-null
description: Context null agent
context:
---
Prompt`,
    "context-null",
  );
  expect(
    discovery.agents.find((a) => a.name === "context-null"),
  ).toBeUndefined();
});

test("context false coexists with sibling model tools skills sampling fields", async () => {
  const discovery = await discoverAgent(
    `---
name: context-false-siblings
description: Context false with siblings
context: false
model: claude-sonnet-4
provider: anthropic
tools: bash, read
skills: helper, reviewer
thinking: high
temperature: 0.5
top_p: 0.9
---
Prompt`,
    "context-false-siblings",
  );
  const agent = discovery.agents.find(
    (a) => a.name === "context-false-siblings",
  );
  expect(agent).toBeDefined();
  if (agent) {
    expect(agent.context).toBe(false);
    expect(Object.hasOwn(agent, "context")).toBe(true);
    expect(agent.model).toBe("claude-sonnet-4");
    expect(agent.provider).toBe("anthropic");
    expect(agent.tools).toEqual(["bash", "read"]);
    expect(agent.skills).toEqual(["helper", "reviewer"]);
    expect(agent.thinking).toBe("high");
    expect(agent.temperature).toBe(0.5);
    expect(agent.topP).toBe(0.9);
  }
});

test("context true coexists with sibling fields and omits own context", async () => {
  const discovery = await discoverAgent(
    `---
name: context-true-siblings
description: Context true with siblings
context: true
model: gpt-5
tools: bash
---
Prompt`,
    "context-true-siblings",
  );
  const agent = discovery.agents.find(
    (a) => a.name === "context-true-siblings",
  );
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "context")).toBe(false);
    expect(agent.context).toBeUndefined();
    expect(agent.model).toBe("gpt-5");
    expect(agent.tools).toEqual(["bash"]);
  }
});

test("skills false discovery stores agent.skills === false as own property", async () => {
  const discovery = await discoverAgent(
    `---
name: skills-false
description: Skills false agent
skills: false
---
Prompt`,
    "skills-false",
  );
  const agent = discovery.agents.find((a) => a.name === "skills-false");
  expect(agent).toBeDefined();
  if (agent) {
    expect(agent.skills).toBe(false);
    expect(Object.hasOwn(agent, "skills")).toBe(true);
  }
});

test("skills true rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: skills-true
description: Skills true agent
skills: true
---
Prompt`,
    "skills-true",
  );
  expect(
    discovery.agents.find((a) => a.name === "skills-true"),
  ).toBeUndefined();
});

test("skills number rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: skills-number
description: Skills number agent
skills: 42
---
Prompt`,
    "skills-number",
  );
  expect(
    discovery.agents.find((a) => a.name === "skills-number"),
  ).toBeUndefined();
});

test("skills false coexists with sibling model tools context sampling fields", async () => {
  const discovery = await discoverAgent(
    `---
name: skills-false-siblings
description: Skills false with siblings
skills: false
context: false
model: claude-sonnet-4
provider: anthropic
tools: bash, read
thinking: high
temperature: 0.5
top_p: 0.9
---
Prompt`,
    "skills-false-siblings",
  );
  const agent = discovery.agents.find(
    (a) => a.name === "skills-false-siblings",
  );
  expect(agent).toBeDefined();
  if (agent) {
    expect(agent.skills).toBe(false);
    expect(agent.context).toBe(false);
    expect(agent.model).toBe("claude-sonnet-4");
    expect(agent.provider).toBe("anthropic");
    expect(agent.tools).toEqual(["bash", "read"]);
    expect(agent.thinking).toBe("high");
    expect(agent.temperature).toBe(0.5);
    expect(agent.topP).toBe(0.9);
  }
});

test("null sampling frontmatter values are rejected with warning and omitted", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "null-sampling.md"),
    `---
name: null-sampling
description: Null sampling
temperature: null
top_p: null
---
Prompt`,
  );
  const { result: discovery, warnings } = await withCapturedWarnings(() =>
    discoverAgentsAsync(cwd, "user"),
  );
  const agent = discovery.agents.find((a) => a.name === "null-sampling");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "temperature")).toBe(false);
    expect(Object.hasOwn(agent, "topP")).toBe(false);
  }
  expect(
    warnings.some(
      (w) => w.includes("null-sampling") && w.includes("temperature"),
    ),
  ).toBe(true);
  expect(
    warnings.some((w) => w.includes("null-sampling") && w.includes("top_p")),
  ).toBe(true);
});

test("bare YAML skills null discovers agent with skills as empty array own property", async () => {
  const discovery = await discoverAgent(
    `---
name: skills-null
description: Skills null agent
skills:
---
Prompt`,
    "skills-null",
  );
  const agent = discovery.agents.find((a) => a.name === "skills-null");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.skills)).toBe(true);
    expect(agent.skills).toHaveLength(0);
    expect(Object.hasOwn(agent, "skills")).toBe(true);
  }
});

test("empty string skills discovers agent with skills as empty array own property", async () => {
  const discovery = await discoverAgent(
    `---
name: skills-empty
description: Skills empty agent
skills: ""
---
Prompt`,
    "skills-empty",
  );
  const agent = discovery.agents.find((a) => a.name === "skills-empty");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.skills)).toBe(true);
    expect(agent.skills).toHaveLength(0);
    expect(Object.hasOwn(agent, "skills")).toBe(true);
  }
});

// --- T-001: extensions frontmatter normalization ---

test("omitted extensions frontmatter omits own extensions property", async () => {
  const discovery = await discoverAgent(
    `---
name: no-extensions
description: No extensions field
---
Prompt`,
    "no-extensions",
  );
  const agent = discovery.agents.find((a) => a.name === "no-extensions");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "extensions")).toBe(false);
    expect(agent.extensions).toBeUndefined();
  }
});

test("extensions false discovers agent with extensions as empty array own property", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-false
description: Extensions false
extensions: false
---
Prompt`,
    "extensions-false",
  );
  const agent = discovery.agents.find((a) => a.name === "extensions-false");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.extensions)).toBe(true);
    expect(agent.extensions).toHaveLength(0);
    expect(Object.hasOwn(agent, "extensions")).toBe(true);
  }
});

test("extensions empty YAML list discovers agent with extensions as empty array own property", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-empty-list
description: Extensions empty list
extensions: []
---
Prompt`,
    "extensions-empty-list",
  );
  const agent = discovery.agents.find(
    (a) => a.name === "extensions-empty-list",
  );
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.extensions)).toBe(true);
    expect(agent.extensions).toHaveLength(0);
    expect(Object.hasOwn(agent, "extensions")).toBe(true);
  }
});

test("extensions empty string discovers agent with extensions as empty array own property", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-empty-str
description: Extensions empty string
extensions: ""
---
Prompt`,
    "extensions-empty-str",
  );
  const agent = discovery.agents.find((a) => a.name === "extensions-empty-str");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.extensions)).toBe(true);
    expect(agent.extensions).toHaveLength(0);
    expect(Object.hasOwn(agent, "extensions")).toBe(true);
  }
});

test("extensions whitespace-only string discovers agent with extensions as empty array own property", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-whitespace
description: Extensions whitespace
extensions: "   "
---
Prompt`,
    "extensions-whitespace",
  );
  const agent = discovery.agents.find(
    (a) => a.name === "extensions-whitespace",
  );
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.extensions)).toBe(true);
    expect(agent.extensions).toHaveLength(0);
    expect(Object.hasOwn(agent, "extensions")).toBe(true);
  }
});

test("extensions comma-only string discovers agent with extensions as empty array own property", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-comma-only
description: Extensions comma only
extensions: ","
---
Prompt`,
    "extensions-comma-only",
  );
  const agent = discovery.agents.find(
    (a) => a.name === "extensions-comma-only",
  );
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.extensions)).toBe(true);
    expect(agent.extensions).toHaveLength(0);
    expect(Object.hasOwn(agent, "extensions")).toBe(true);
  }
});

test("extensions comma-delimited string parses ordered raw names preserving duplicates", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-names
description: Extensions names
extensions: "context-mode, npm:helper, context-mode"
---
Prompt`,
    "extensions-names",
  );
  const agent = discovery.agents.find((a) => a.name === "extensions-names");
  expect(agent).toBeDefined();
  if (agent) {
    expect(agent.extensions).toEqual([
      "context-mode",
      "npm:helper",
      "context-mode",
    ]);
    expect(Object.hasOwn(agent, "extensions")).toBe(true);
  }
});

test("extensions comma-delimited string trims whitespace around names", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-trimmed
description: Extensions trimmed
extensions: "  context-mode ,  npm:helper  "
---
Prompt`,
    "extensions-trimmed",
  );
  const agent = discovery.agents.find((a) => a.name === "extensions-trimmed");
  expect(agent).toBeDefined();
  if (agent) {
    expect(agent.extensions).toEqual(["context-mode", "npm:helper"]);
  }
});

test("extensions true rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-true
description: Extensions true
extensions: true
---
Prompt`,
    "extensions-true",
  );
  expect(
    discovery.agents.find((a) => a.name === "extensions-true"),
  ).toBeUndefined();
});

test("extensions number rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-number
description: Extensions number
extensions: 42
---
Prompt`,
    "extensions-number",
  );
  expect(
    discovery.agents.find((a) => a.name === "extensions-number"),
  ).toBeUndefined();
});

test("extensions object rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-object
description: Extensions object
extensions:
  key: value
---
Prompt`,
    "extensions-object",
  );
  expect(
    discovery.agents.find((a) => a.name === "extensions-object"),
  ).toBeUndefined();
});

test("bare YAML extensions null rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-null
description: Extensions null
extensions:
---
Prompt`,
    "extensions-null",
  );
  expect(
    discovery.agents.find((a) => a.name === "extensions-null"),
  ).toBeUndefined();
});

test("extensions non-empty YAML list rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-nonempty-list
description: Extensions nonempty list
extensions:
  - context-mode
  - npm:helper
---
Prompt`,
    "extensions-nonempty-list",
  );
  expect(
    discovery.agents.find((a) => a.name === "extensions-nonempty-list"),
  ).toBeUndefined();
});

test("extensions false coexists with sibling model tools skills context sampling fields", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-false-siblings
description: Extensions false with siblings
extensions: false
model: claude-sonnet-4
provider: anthropic
tools: bash, read
skills: helper, reviewer
context: false
thinking: high
temperature: 0.5
top_p: 0.9
---
Prompt`,
    "extensions-false-siblings",
  );
  const agent = discovery.agents.find(
    (a) => a.name === "extensions-false-siblings",
  );
  expect(agent).toBeDefined();
  if (agent) {
    expect(agent.extensions).toEqual([]);
    expect(Object.hasOwn(agent, "extensions")).toBe(true);
    expect(agent.model).toBe("claude-sonnet-4");
    expect(agent.provider).toBe("anthropic");
    expect(agent.tools).toEqual(["bash", "read"]);
    expect(agent.skills).toEqual(["helper", "reviewer"]);
    expect(agent.context).toBe(false);
    expect(agent.thinking).toBe("high");
    expect(agent.temperature).toBe(0.5);
    expect(agent.topP).toBe(0.9);
  }
});

test("extensions named string coexists with sibling model tools skills context sampling fields", async () => {
  const discovery = await discoverAgent(
    `---
name: extensions-named-siblings
description: Extensions named with siblings
extensions: "context-mode, npm:helper"
model: gpt-5
provider: openai
tools: bash, read
skills: helper
context: false
thinking: medium
temperature: 0.3
top_p: 0.7
---
Prompt`,
    "extensions-named-siblings",
  );
  const agent = discovery.agents.find(
    (a) => a.name === "extensions-named-siblings",
  );
  expect(agent).toBeDefined();
  if (agent) {
    expect(agent.extensions).toEqual(["context-mode", "npm:helper"]);
    expect(agent.model).toBe("gpt-5");
    expect(agent.provider).toBe("openai");
    expect(agent.tools).toEqual(["bash", "read"]);
    expect(agent.skills).toEqual(["helper"]);
    expect(agent.context).toBe(false);
    expect(agent.thinking).toBe("medium");
    expect(agent.temperature).toBe(0.3);
    expect(agent.topP).toBe(0.7);
  }
});

// --- T-001: replace_prompt frontmatter parsing ---

test("replace_prompt true discovers agent with replacePrompt true as own property", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-true
description: Replace prompt true
replace_prompt: true
---
Replacement prompt body.`,
    "replace-true",
  );
  const agent = discovery.agents.find((a) => a.name === "replace-true");
  expect(agent).toBeDefined();
  if (agent) {
    expect(agent.replacePrompt).toBe(true);
    expect(Object.hasOwn(agent, "replacePrompt")).toBe(true);
    expect(agent.systemPrompt).toBe("Replacement prompt body.");
  }
});

test("replace_prompt true coexists with sibling fields", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-true-siblings
description: Replace prompt true with siblings
replace_prompt: true
model: gpt-5
provider: openai
tools: bash, read
skills: helper
context: false
thinking: medium
temperature: 0.3
top_p: 0.7
---
Replacement body with siblings.`,
    "replace-true-siblings",
  );
  const agent = discovery.agents.find(
    (a) => a.name === "replace-true-siblings",
  );
  expect(agent).toBeDefined();
  if (agent) {
    expect(agent.replacePrompt).toBe(true);
    expect(Object.hasOwn(agent, "replacePrompt")).toBe(true);
    expect(agent.model).toBe("gpt-5");
    expect(agent.provider).toBe("openai");
    expect(agent.tools).toEqual(["bash", "read"]);
    expect(agent.skills).toEqual(["helper"]);
    expect(agent.context).toBe(false);
    expect(agent.thinking).toBe("medium");
    expect(agent.temperature).toBe(0.3);
    expect(agent.topP).toBe(0.7);
    expect(agent.systemPrompt).toBe("Replacement body with siblings.");
  }
});

test("replace_prompt false omits own replacePrompt property", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-false
description: Replace prompt false
replace_prompt: false
---
Legacy append body.`,
    "replace-false",
  );
  const agent = discovery.agents.find((a) => a.name === "replace-false");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "replacePrompt")).toBe(false);
    expect(agent.replacePrompt).toBeUndefined();
  }
});

test("omitted replace_prompt omits own replacePrompt property", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-omitted
description: Replace prompt omitted
---
Legacy append body.`,
    "replace-omitted",
  );
  const agent = discovery.agents.find((a) => a.name === "replace-omitted");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "replacePrompt")).toBe(false);
    expect(agent.replacePrompt).toBeUndefined();
  }
});

test("replace_prompt true with empty body rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-empty-body
description: Replace prompt empty body
replace_prompt: true
---`,
    "replace-empty-body",
  );
  expect(
    discovery.agents.find((a) => a.name === "replace-empty-body"),
  ).toBeUndefined();
});

test("replace_prompt true with whitespace-only body rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-whitespace-body
description: Replace prompt whitespace body
replace_prompt: true
---
   \n\t  `,
    "replace-whitespace-body",
  );
  expect(
    discovery.agents.find((a) => a.name === "replace-whitespace-body"),
  ).toBeUndefined();
});

test("non-boolean replace_prompt string rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-string
description: Replace prompt string
replace_prompt: "true"
---
Body`,
    "replace-string",
  );
  expect(
    discovery.agents.find((a) => a.name === "replace-string"),
  ).toBeUndefined();
});

test("non-boolean replace_prompt number rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-number
description: Replace prompt number
replace_prompt: 1
---
Body`,
    "replace-number",
  );
  expect(
    discovery.agents.find((a) => a.name === "replace-number"),
  ).toBeUndefined();
});

test("non-boolean replace_prompt object rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-object
description: Replace prompt object
replace_prompt:
  enabled: true
---
Body`,
    "replace-object",
  );
  expect(
    discovery.agents.find((a) => a.name === "replace-object"),
  ).toBeUndefined();
});

test("bare YAML replace_prompt null rejects agent from discovery", async () => {
  const discovery = await discoverAgent(
    `---
name: replace-null
description: Replace prompt null
replace_prompt:
---
Body`,
    "replace-null",
  );
  expect(
    discovery.agents.find((a) => a.name === "replace-null"),
  ).toBeUndefined();
});

test("replace_prompt invalid coexists with sibling valid agents", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "replace-invalid.md"),
    `---
name: replace-invalid
description: Replace prompt invalid
replace_prompt: "true"
---
Body`,
  );
  await writeFile(
    path.join(userDir, "sibling-valid.md"),
    `---
name: sibling-valid
description: Sibling valid agent
---
Sibling body`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === "replace-invalid"),
  ).toBeUndefined();
  const sibling = discovery.agents.find((a) => a.name === "sibling-valid");
  expect(sibling).toBeDefined();
  if (sibling) {
    expect(Object.hasOwn(sibling, "replacePrompt")).toBe(false);
  }
});
