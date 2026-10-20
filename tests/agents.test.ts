import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "../src/agent/agents.js";
import {
  discoverAgentsAsync,
  formatAgentList,
  isDirectoryAsync,
  readMarkdownDirWithStatusAsync,
} from "../src/agent/agents.js";
import {
  denyFsAccess,
  makeAgentHome,
  makeTempDir,
  setupFakePi,
  setupHooks,
} from "./helpers.js";

setupHooks();

async function discoverAgent(
  yamlBody: string,
  agentName: string,
): ReturnType<typeof discoverAgentsAsync> {
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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

test.each([
  {
    name: "parse model-only frontmatter with undefined provider",
    fileName: "model-only.md",
    yamlBody: `---
name: model-only
description: Model only
model: gpt-5
---
Prompt`,
    agentName: "model-only",
  },
  {
    name: "blank provider with model frontmatter normalizes to model-only discovery",
    fileName: "blank-provider-model.md",
    yamlBody: `---
name: blank-provider-model
description: Blank provider with model
model: gpt-5
provider: "   "
---
Prompt`,
    agentName: "blank-provider-model",
  },
])("$name", async (row) => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(path.join(userDir, row.fileName), row.yamlBody);
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === row.agentName);
  expect(agent?.model).toBe("gpt-5");
  expect(agent?.provider).toBeUndefined();
});

test.each([
  {
    name: "provider with whitespace-only model is rejected from discovery",
    fileName: "provider-blank-model.md",
    yamlBody: `---
name: provider-blank-model
description: Provider with blank model
provider: openai
model: "   "
---
Prompt`,
    agentName: "provider-blank-model",
  },
  {
    name: "parse provider-only frontmatter is rejected from discovery",
    fileName: "provider-only.md",
    yamlBody: `---
name: provider-only
description: Provider only
provider: openai
---
Prompt`,
    agentName: "provider-only",
  },
  {
    name: "provider-only with empty model string is rejected from discovery",
    fileName: "provider-only-empty-model.md",
    yamlBody: `---
name: provider-only-empty-model
description: Provider only with empty model
provider: openai
model: ""
---
Prompt`,
    agentName: "provider-only-empty-model",
  },
  {
    name: "non-string provider field is rejected from discovery",
    fileName: "bad-provider.md",
    yamlBody: `---
name: bad-provider
description: Bad provider
provider:
  - openai
---
Prompt`,
    agentName: "bad-provider",
  },
  {
    name: "missing required description field is rejected from discovery",
    fileName: "no-description.md",
    yamlBody: `---
name: no-description
---
Prompt`,
    agentName: "no-description",
  },
  {
    name: "non-string thinking field is rejected from discovery",
    fileName: "bad-thinking.md",
    yamlBody: `---
name: bad-thinking
description: Bad thinking
thinking: 123
---
Prompt`,
    agentName: "bad-thinking",
  },
])("$name", async (row) => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(path.join(userDir, row.fileName), row.yamlBody);
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === row.agentName),
  ).toBeUndefined();
});

test("blank model and provider strings normalize to undefined", async () => {
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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

test.each([
  {
    name: "non-string model field is rejected from discovery",
    fileName: "bad-model.md",
    yamlBody: `---
name: bad-model
description: Bad model
model: 123
---
Prompt`,
    agentName: "bad-model",
  },
  {
    name: "non-string tools field is rejected from discovery",
    fileName: "bad-tools.md",
    yamlBody: `---
name: bad-tools
description: Bad tools
tools:
  - bash
  - read
---
Prompt`,
    agentName: "bad-tools",
  },
  {
    name: "non-string skills field is rejected from discovery",
    fileName: "bad-skills.md",
    yamlBody: `---
name: bad-skills
description: Bad skills
skills:
  - helper
  - reviewer
---
Prompt`,
    agentName: "bad-skills",
  },
  {
    name: "parseAgentConfig rejects non-string description with null return",
    fileName: "desc-null.md",
    yamlBody: `---
name: desc-null
description:
---
Prompt.`,
    agentName: "desc-null",
  },
])("$name", async (row) => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(path.join(userDir, row.fileName), row.yamlBody);
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.name === row.agentName),
  ).toBeUndefined();
});

test("malformed frontmatter that throws is rejected from discovery", async () => {
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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

test.each([
  {
    name: "missing required name field is rejected from discovery",
    fileName: "no-name.md",
    yamlBody: `---
description: Missing name
---
Prompt`,
    description: "Missing name",
  },
  {
    name: "parseAgentConfig rejects non-string name with null return",
    fileName: "name-null.md",
    yamlBody: `---
name:
description: Has description
---
Prompt.`,
    description: "Has description",
  },
])("$name", async (row) => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(path.join(userDir, row.fileName), row.yamlBody);
  const discovery = await discoverAgentsAsync(cwd, "user");
  expect(
    discovery.agents.find((a) => a.description === row.description),
  ).toBeUndefined();
});

test("empty skills string produces empty array in discovery", async () => {
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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

test.each([
  {
    name: "thinking values are normalized to lowercase in discovery",
    fileName: "uppercase-thinking.md",
    yamlBody: `---
name: uppercase-thinking
description: Uppercase thinking
thinking: HIGH
---
Prompt`,
    agentName: "uppercase-thinking",
    expectedThinking: "high",
  },
  {
    name: "max thinking value is accepted in discovery",
    fileName: "max-thinking.md",
    yamlBody: `---
name: max-thinking
description: Max thinking
thinking: max
---
Prompt`,
    agentName: "max-thinking",
    expectedThinking: "max",
  },
])("$name", async (row) => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(path.join(userDir, row.fileName), row.yamlBody);
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === row.agentName);
  expect(agent).toBeDefined();
  expect(agent?.thinking).toBe(row.expectedThinking);
});

test("symlinked markdown files are discovered", async () => {
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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
  const { agentDir, cwd } = await makeAgentHome();
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

test.each([
  {
    name: "context true discovery omits own context property",
    yamlBody: `---
name: context-true
description: Context true agent
context: true
---
Prompt`,
    fileStem: "context-true",
    agentName: "context-true",
  },
  {
    name: "omitted context field discovery omits own context property",
    yamlBody: `---
name: no-context
description: No context field
---
Prompt`,
    fileStem: "no-context",
    agentName: "no-context",
  },
])("$name", async (row) => {
  const discovery = await discoverAgent(row.yamlBody, row.fileStem);
  const agent = discovery.agents.find((a) => a.name === row.agentName);
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "context")).toBe(false);
    expect(agent.context).toBeUndefined();
  }
});

test.each([
  {
    name: "non-boolean context string rejects agent from discovery",
    yamlBody: `---
name: context-string
description: Context string agent
context: "false"
---
Prompt`,
    fileStem: "context-string",
    agentName: "context-string",
  },
  {
    name: "non-boolean context number rejects agent from discovery",
    yamlBody: `---
name: context-number
description: Context number agent
context: 0
---
Prompt`,
    fileStem: "context-number",
    agentName: "context-number",
  },
  {
    name: "non-boolean context array rejects agent from discovery",
    yamlBody: `---
name: context-array
description: Context array agent
context:
  - false
---
Prompt`,
    fileStem: "context-array",
    agentName: "context-array",
  },
  {
    name: "non-boolean context object rejects agent from discovery",
    yamlBody: `---
name: context-object
description: Context object agent
context:
  enabled: false
---
Prompt`,
    fileStem: "context-object",
    agentName: "context-object",
  },
  {
    name: "bare YAML context null rejects agent from discovery",
    yamlBody: `---
name: context-null
description: Context null agent
context:
---
Prompt`,
    fileStem: "context-null",
    agentName: "context-null",
  },
  {
    name: "skills true rejects agent from discovery",
    yamlBody: `---
name: skills-true
description: Skills true agent
skills: true
---
Prompt`,
    fileStem: "skills-true",
    agentName: "skills-true",
  },
  {
    name: "skills number rejects agent from discovery",
    yamlBody: `---
name: skills-number
description: Skills number agent
skills: 42
---
Prompt`,
    fileStem: "skills-number",
    agentName: "skills-number",
  },
  {
    name: "extensions true rejects agent from discovery",
    yamlBody: `---
name: extensions-true
description: Extensions true
extensions: true
---
Prompt`,
    fileStem: "extensions-true",
    agentName: "extensions-true",
  },
  {
    name: "extensions number rejects agent from discovery",
    yamlBody: `---
name: extensions-number
description: Extensions number
extensions: 42
---
Prompt`,
    fileStem: "extensions-number",
    agentName: "extensions-number",
  },
  {
    name: "extensions object rejects agent from discovery",
    yamlBody: `---
name: extensions-object
description: Extensions object
extensions:
  key: value
---
Prompt`,
    fileStem: "extensions-object",
    agentName: "extensions-object",
  },
  {
    name: "bare YAML extensions null rejects agent from discovery",
    yamlBody: `---
name: extensions-null
description: Extensions null
extensions:
---
Prompt`,
    fileStem: "extensions-null",
    agentName: "extensions-null",
  },
  {
    name: "extensions non-empty YAML list rejects agent from discovery",
    yamlBody: `---
name: extensions-nonempty-list
description: Extensions nonempty list
extensions:
  - context-mode
  - npm:helper
---
Prompt`,
    fileStem: "extensions-nonempty-list",
    agentName: "extensions-nonempty-list",
  },
  {
    name: "replace_prompt true with empty body rejects agent from discovery",
    yamlBody: `---
name: replace-empty-body
description: Replace prompt empty body
replace_prompt: true
---`,
    fileStem: "replace-empty-body",
    agentName: "replace-empty-body",
  },
  {
    name: "replace_prompt true with whitespace-only body rejects agent from discovery",
    yamlBody: `---
name: replace-whitespace-body
description: Replace prompt whitespace body
replace_prompt: true
---
   \n\t  `,
    fileStem: "replace-whitespace-body",
    agentName: "replace-whitespace-body",
  },
  {
    name: "non-boolean replace_prompt string rejects agent from discovery",
    yamlBody: `---
name: replace-string
description: Replace prompt string
replace_prompt: "true"
---
Body`,
    fileStem: "replace-string",
    agentName: "replace-string",
  },
  {
    name: "non-boolean replace_prompt number rejects agent from discovery",
    yamlBody: `---
name: replace-number
description: Replace prompt number
replace_prompt: 1
---
Body`,
    fileStem: "replace-number",
    agentName: "replace-number",
  },
  {
    name: "non-boolean replace_prompt object rejects agent from discovery",
    yamlBody: `---
name: replace-object
description: Replace prompt object
replace_prompt:
  enabled: true
---
Body`,
    fileStem: "replace-object",
    agentName: "replace-object",
  },
  {
    name: "bare YAML replace_prompt null rejects agent from discovery",
    yamlBody: `---
name: replace-null
description: Replace prompt null
replace_prompt:
---
Body`,
    fileStem: "replace-null",
    agentName: "replace-null",
  },
])("$name", async (row) => {
  const discovery = await discoverAgent(row.yamlBody, row.fileStem);
  expect(
    discovery.agents.find((a) => a.name === row.agentName),
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
  const { agentDir, cwd } = await makeAgentHome();
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

test.each([
  {
    name: "bare YAML skills null discovers agent with skills as empty array own property",
    yamlBody: `---
name: skills-null
description: Skills null agent
skills:
---
Prompt`,
    fileStem: "skills-null",
    agentName: "skills-null",
  },
  {
    name: "empty string skills discovers agent with skills as empty array own property",
    yamlBody: `---
name: skills-empty
description: Skills empty agent
skills: ""
---
Prompt`,
    fileStem: "skills-empty",
    agentName: "skills-empty",
  },
])("$name", async (row) => {
  const discovery = await discoverAgent(row.yamlBody, row.fileStem);
  const agent = discovery.agents.find((a) => a.name === row.agentName);
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.skills)).toBe(true);
    expect(agent.skills).toHaveLength(0);
    expect(Object.hasOwn(agent, "skills")).toBe(true);
  }
});

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

test.each([
  {
    name: "extensions false discovers agent with extensions as empty array own property",
    yamlBody: `---
name: extensions-false
description: Extensions false
extensions: false
---
Prompt`,
    fileStem: "extensions-false",
    agentName: "extensions-false",
  },
  {
    name: "extensions empty string discovers agent with extensions as empty array own property",
    yamlBody: `---
name: extensions-empty-str
description: Extensions empty string
extensions: ""
---
Prompt`,
    fileStem: "extensions-empty-str",
    agentName: "extensions-empty-str",
  },
])("$name", async (row) => {
  const discovery = await discoverAgent(row.yamlBody, row.fileStem);
  const agent = discovery.agents.find((a) => a.name === row.agentName);
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.extensions)).toBe(true);
    expect(agent.extensions).toHaveLength(0);
    expect(Object.hasOwn(agent, "extensions")).toBe(true);
  }
});

test.each([
  {
    name: "extensions empty YAML list discovers agent with extensions as empty array own property",
    yamlBody: `---
name: extensions-empty-list
description: Extensions empty list
extensions: []
---
Prompt`,
    fileStem: "extensions-empty-list",
    agentName: "extensions-empty-list",
  },
  {
    name: "extensions whitespace-only string discovers agent with extensions as empty array own property",
    yamlBody: `---
name: extensions-whitespace
description: Extensions whitespace
extensions: "   "
---
Prompt`,
    fileStem: "extensions-whitespace",
    agentName: "extensions-whitespace",
  },
  {
    name: "extensions comma-only string discovers agent with extensions as empty array own property",
    yamlBody: `---
name: extensions-comma-only
description: Extensions comma only
extensions: ","
---
Prompt`,
    fileStem: "extensions-comma-only",
    agentName: "extensions-comma-only",
  },
])("$name", async (row) => {
  const discovery = await discoverAgent(row.yamlBody, row.fileStem);
  const agent = discovery.agents.find((a) => a.name === row.agentName);
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

test.each([
  {
    name: "replace_prompt false omits own replacePrompt property",
    yamlBody: `---
name: replace-false
description: Replace prompt false
replace_prompt: false
---
Legacy append body.`,
    fileStem: "replace-false",
    agentName: "replace-false",
  },
  {
    name: "omitted replace_prompt omits own replacePrompt property",
    yamlBody: `---
name: replace-omitted
description: Replace prompt omitted
---
Legacy append body.`,
    fileStem: "replace-omitted",
    agentName: "replace-omitted",
  },
])("$name", async (row) => {
  const discovery = await discoverAgent(row.yamlBody, row.fileStem);
  const agent = discovery.agents.find((a) => a.name === row.agentName);
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "replacePrompt")).toBe(false);
    expect(agent.replacePrompt).toBeUndefined();
  }
});

test("replace_prompt invalid coexists with sibling valid agents", async () => {
  const { agentDir, cwd } = await makeAgentHome();
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

// --- discoverAgentsAsync scope variants ---

test("isDirectoryAsync returns true for existing directories", async () => {
  const { agentDir } = await makeAgentHome();
  const result = await isDirectoryAsync(agentDir);
  expect(result).toBe(true);
});

test("isDirectoryAsync returns false for non-existent paths", async () => {
  const { agentDir } = await makeAgentHome();
  const result = await isDirectoryAsync(path.join(agentDir, "nonexistent"));
  expect(result).toBe(false);
});

test("isDirectoryAsync returns false for files", async () => {
  const { agentDir } = await makeAgentHome();
  const filePath = path.join(agentDir, "agents", "hang.md");
  const result = await isDirectoryAsync(filePath);
  expect(result).toBe(false);
});

test("readMarkdownDirWithStatusAsync returns empty entries for dir with no markdown files", async () => {
  const { agentDir } = await makeAgentHome();
  const emptyDir = path.join(agentDir, "empty");
  await Bun.$`mkdir -p ${emptyDir}`;
  await writeFile(path.join(emptyDir, "notes.txt"), "text");
  const listing = await readMarkdownDirWithStatusAsync(emptyDir);
  expect(listing).toEqual({ entries: [], ok: true });
});

test("discoverAgentsAsync with project scope discovers project agents", async () => {
  const { cwd } = await makeAgentHome();
  const projectDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectDir}`;
  await writeFile(
    path.join(projectDir, "proj-agent.md"),
    `---
name: proj-agent
description: Project agent
tools: bash
thinking: low
---
Project prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "project");
  expect(discovery.agents).toHaveLength(1);
  const agent = discovery.agents[0];
  if (!agent) throw new Error("expected agent");
  expect(agent.name).toBe("proj-agent");
  expect(agent.source).toBe("project");
  expect(agent.description).toBe("Project agent");
  expect(agent.tools).toEqual(["bash"]);
  expect(agent.thinking).toBe("low");
});

test("discoverAgentsAsync with project scope skips user agents", async () => {
  const { cwd } = await makeAgentHome();
  // user dir has "hang" agent by default — should be skipped for project scope
  const projectDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectDir}`;
  await writeFile(
    path.join(projectDir, "proj-agent.md"),
    `---
name: proj-agent
description: Project only
---
Prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "project");
  expect(discovery.agents).toHaveLength(1);
  const agent = discovery.agents[0];
  if (!agent) throw new Error("expected agent");
  expect(agent.name).toBe("proj-agent");
  expect(agent.source).toBe("project");
});

test("discoverAgentsAsync with both scope merges user and project agents", async () => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  const projectDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectDir}`;
  await writeFile(
    path.join(userDir, "user-agent.md"),
    `---
name: user-agent
description: User-specific agent
---
User prompt.`,
  );
  await writeFile(
    path.join(projectDir, "proj-agent.md"),
    `---
name: proj-agent
description: Project-specific agent
---
Project prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "both");
  const names = discovery.agents.map((a) => a.name).sort();
  expect(names).toContain("hang");
  expect(names).toContain("user-agent");
  expect(names).toContain("proj-agent");
  expect(discovery.scopes.user.agents.length).toBeGreaterThanOrEqual(2);
  expect(discovery.scopes.project.agents.length).toBe(1);
});

test("discoverAgentsAsync with both scope: project agent overrides user agent with same name", async () => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  const projectDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectDir}`;
  await writeFile(
    path.join(userDir, "shared-agent.md"),
    `---
name: shared-agent
description: User version
---
User body.`,
  );
  await writeFile(
    path.join(projectDir, "shared-agent.md"),
    `---
name: shared-agent
description: Project version overrides
tools: bash
thinking: high
---
Project body.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "both");
  const agent = discovery.agents.find((a) => a.name === "shared-agent");
  expect(agent).toBeDefined();
  expect(agent?.source).toBe("project");
  expect(agent?.description).toBe("Project version overrides");
  expect(agent?.tools).toEqual(["bash"]);
  expect(agent?.thinking).toBe("high");
  expect(agent?.systemPrompt).toBe("Project body.");
});

test("discoverAgentsAsync with project scope and no project directory returns empty agents", async () => {
  const { cwd } = await makeAgentHome();
  // cwd has no .pi/agents directory
  const discovery = await discoverAgentsAsync(cwd, "project");
  expect(discovery.agents).toHaveLength(0);
  expect(discovery.projectAgentsDir).toBeNull();
  expect(discovery.scopes.project.agents).toHaveLength(0);
});

test("discoverAgentsAsync with both scope and no project directory returns only user agents", async () => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "only-user.md"),
    `---
name: only-user
description: Only user
---
Prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "both");
  expect(discovery.projectAgentsDir).toBeNull();
  const names = discovery.agents.map((a) => a.name).sort();
  expect(names).toContain("hang");
  expect(names).toContain("only-user");
  expect(discovery.scopes.project.agents).toHaveLength(0);
});

test("discoverAgentsAsync finds project agents in parent directories", async () => {
  const { cwd } = await makeAgentHome();
  const projectDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectDir}`;
  await writeFile(
    path.join(projectDir, "parent-agent.md"),
    `---
name: parent-agent
description: Found in parent
---
Parent prompt.`,
  );
  const subDir = path.join(cwd, "deep", "nested");
  await Bun.$`mkdir -p ${subDir}`;
  const discovery = await discoverAgentsAsync(subDir, "both");
  expect(discovery.projectAgentsDir).toBe(projectDir);
  const agent = discovery.agents.find((a) => a.name === "parent-agent");
  expect(agent).toBeDefined();
  expect(agent?.source).toBe("project");
  expect(agent?.description).toBe("Found in parent");
});

test("discoverAgentsAsync returns scoped markdown files separately", async () => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  const projectDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectDir}`;
  await writeFile(
    path.join(userDir, "extra.md"),
    `---
name: extra
description: Extra user agent
---
Prompt.`,
  );
  await writeFile(
    path.join(projectDir, "project-readme.md"),
    `---
name: project-readme
description: Project readme
---
Prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "both");
  expect(discovery.scopes.user.markdownFiles).toContain("hang.md");
  expect(discovery.scopes.user.markdownFiles).toContain("extra.md");
  expect(discovery.scopes.project.markdownFiles).toContain("project-readme.md");
  expect(discovery.scopes.user.markdownFiles).not.toContain(
    "project-readme.md",
  );
  expect(discovery.scopes.project.markdownFiles).not.toContain("hang.md");
});

test("parseCommaList returns undefined for non-string input", async () => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  // tools as a non-string type (array) is rejected at parseAgentConfig level,
  // but an empty string is parsed by parseCommaList returning undefined
  await writeFile(
    path.join(userDir, "empty-tools-str.md"),
    `---
name: empty-tools-str
description: Empty tools string
tools: ""
---
Prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "empty-tools-str");
  expect(agent).toBeDefined();
  expect(agent?.tools).toBeUndefined();
});

test.each([
  {
    name: "parseCommaList returns undefined for whitespace-only string",
    fileName: "whitespace-tools.md",
    yamlBody: `---
name: whitespace-tools
description: Whitespace tools
tools: "   "
---
Prompt.`,
    agentName: "whitespace-tools",
  },
  {
    name: "parseCommaList returns undefined for comma-only string",
    fileName: "comma-tools.md",
    yamlBody: `---
name: comma-tools
description: Comma tools
tools: ","
---
Prompt.`,
    agentName: "comma-tools",
  },
])("$name", async (row) => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(path.join(userDir, row.fileName), row.yamlBody);
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === row.agentName);
  expect(agent).toBeDefined();
  expect(agent?.tools).toBeUndefined();
});

test("parseCommaList preserves ordering and trims whitespace from tools", async () => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "trimmed-tools.md"),
    `---
name: trimmed-tools
description: Trimmed tools
tools: "  bash ,  read , write  "
---
Prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "trimmed-tools");
  expect(agent).toBeDefined();
  expect(agent?.tools).toEqual(["bash", "read", "write"]);
});

test("parseExtensions with non-empty YAML array passes validation but returns empty array", async () => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "ext-arr.md"),
    `---
name: ext-arr
description: Extensions array
extensions: []
---
Prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agent = discovery.agents.find((a) => a.name === "ext-arr");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Array.isArray(agent.extensions)).toBe(true);
    expect(agent.extensions).toHaveLength(0);
  }
});

test.each([
  {
    name: "formatAgentList handles zero maxItems gracefully",
    maxItems: 0,
    expectedText: "",
    expectedRemaining: 1,
  },
  {
    name: "formatAgentList handles maxItems larger than agent count",
    maxItems: 5,
    expectedText: "alpha (user): First",
    expectedRemaining: 0,
  },
])("$name", (row) => {
  const agents: AgentConfig[] = [
    {
      name: "alpha",
      description: "First",
      systemPrompt: "P",
      source: "user",
      filePath: "a.md",
    },
  ];
  const result = formatAgentList(agents, row.maxItems);
  expect(result.text).toBe(row.expectedText);
  expect(result.remaining).toBe(row.expectedRemaining);
});

test("parseAgentConfig returns null for bare context true — already tested as omission", async () => {
  // context: true is permitted but omitted from output; this is already verified
  // by context-true tests. This test confirms it doesn't reject the agent.
  const discovery = await discoverAgent(
    `---
name: context-true-bare
description: Context true bare
context: true
---
Body`,
    "context-true-bare",
  );
  const agent = discovery.agents.find((a) => a.name === "context-true-bare");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "context")).toBe(false);
  }
});

test("parseSamplingValue returns undefined for NaN with warning", async () => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "nan-temp.md"),
    `---
name: nan-temp
description: NaN temperature
temperature: .nan
---
Prompt.`,
  );
  const { result: discovery, warnings } = await withCapturedWarnings(() =>
    discoverAgentsAsync(cwd, "user"),
  );
  const agent = discovery.agents.find((a) => a.name === "nan-temp");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "temperature")).toBe(false);
    expect(agent.temperature).toBeUndefined();
  }
  expect(
    warnings.some((w) => w.includes("nan-temp") && w.includes("temperature")),
  ).toBe(true);
});

test("parseSamplingValue returns undefined for Infinity with warning", async () => {
  const { agentDir, cwd } = await makeAgentHome();
  const userDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(userDir, "inf-top-p.md"),
    `---
name: inf-top-p
description: Infinity top_p
top_p: .inf
---
Prompt.`,
  );
  const { result: discovery, warnings } = await withCapturedWarnings(() =>
    discoverAgentsAsync(cwd, "user"),
  );
  const agent = discovery.agents.find((a) => a.name === "inf-top-p");
  expect(agent).toBeDefined();
  if (agent) {
    expect(Object.hasOwn(agent, "topP")).toBe(false);
    expect(agent.topP).toBeUndefined();
  }
  expect(
    warnings.some((w) => w.includes("inf-top-p") && w.includes("top_p")),
  ).toBe(true);
});

test.each([
  {
    name: "thinking level off is recognized and preserved",
    yamlBody: `---
name: thinking-off
description: Thinking off
thinking: off
---
Prompt.`,
    fileStem: "thinking-off",
    agentName: "thinking-off",
    expectedThinking: "off",
  },
  {
    name: "thinking level xhigh is recognized and preserved",
    yamlBody: `---
name: thinking-xhigh
description: Thinking xhigh
thinking: xhigh
---
Prompt.`,
    fileStem: "thinking-xhigh",
    agentName: "thinking-xhigh",
    expectedThinking: "xhigh",
  },
])("$name", async (row) => {
  const discovery = await discoverAgent(row.yamlBody, row.fileStem);
  const agent = discovery.agents.find((a) => a.name === row.agentName);
  expect(agent).toBeDefined();
  expect(agent?.thinking).toBe(row.expectedThinking);
});

test.each([
  {
    name: "tools comma-list with trailing comma normalizes correctly",
    yamlBody: `---
name: trailing-comma
description: Trailing comma in tools
tools: "bash, read,"
---
Prompt.`,
    fileStem: "trailing-comma",
    agentName: "trailing-comma",
  },
  {
    name: "tools comma-list with leading comma normalizes correctly",
    yamlBody: `---
name: leading-comma
description: Leading comma in tools
tools: ", bash, read"
---
Prompt.`,
    fileStem: "leading-comma",
    agentName: "leading-comma",
  },
])("$name", async (row) => {
  const discovery = await discoverAgent(row.yamlBody, row.fileStem);
  const agent = discovery.agents.find((a) => a.name === row.agentName);
  expect(agent).toBeDefined();
  expect(agent?.tools).toEqual(["bash", "read"]);
});

test("tools comma-list preserves delimiter usage as-is", async () => {
  const discovery = await discoverAgent(
    `---
name: preserve-delim
description: Preserve delimiter
tools: bash, read, write
---
Prompt.`,
    "preserve-delim",
  );
  const agent = discovery.agents.find((a) => a.name === "preserve-delim");
  expect(agent).toBeDefined();
  expect(agent?.tools).toEqual(["bash", "read", "write"]);
});

test("formatAgentList", () => {
  const agents: AgentConfig[] = [
    {
      name: "a1",
      source: "user",
      description: "d1",
      systemPrompt: "",
      filePath: "a1.md",
    },
    {
      name: "a2",
      source: "project",
      description: "d2",
      systemPrompt: "",
      filePath: "a2.md",
    },
  ];
  const res1 = formatAgentList(agents, 1);
  expect(res1.text).toBe("a1 (user): d1");
  expect(res1.remaining).toBe(1);
  const res2 = formatAgentList(agents, 2);
  expect(res2.text).toBe("a1 (user): d1; a2 (project): d2");
  expect(res2.remaining).toBe(0);
  const res0 = formatAgentList([], 10);
  expect(res0.text).toBe("none");
});

test("discoverAgents preserves scope filtering and project override precedence", async () => {
  const root = await makeTempDir("pi-subagent-scope-");
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "work", "nested");
  const userDir = path.join(agentDir, "agents");
  const projectDir = path.join(root, "work", ".pi", "agents");
  await mkdir(userDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(userDir, "same.md"),
    `---
name: same
description: User same
---
User prompt`,
  );
  await writeFile(
    path.join(userDir, "user-only.md"),
    `---
name: user-only
description: User only
---
User prompt`,
  );
  await writeFile(
    path.join(projectDir, "same.md"),
    `---
name: same
description: Project same
---
Project prompt`,
  );
  await writeFile(
    path.join(projectDir, "project-only.md"),
    `---
name: project-only
description: Project only
---
Project prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const userDiscovery = await discoverAgentsAsync(cwd, "user");
  const projectDiscovery = await discoverAgentsAsync(cwd, "project");
  const bothDiscovery = await discoverAgentsAsync(cwd, "both");
  const userAgents = userDiscovery.agents;
  const projectAgents = projectDiscovery.agents;
  const bothAgents = bothDiscovery.agents;
  expect(userAgents.find((a) => a.name === "same")?.source).toBe("user");
  expect(userAgents.some((a) => a.name === "project-only")).toBe(false);
  expect(projectAgents.find((a) => a.name === "same")?.source).toBe("project");
  expect(projectAgents.some((a) => a.name === "user-only")).toBe(false);
  expect(bothAgents.find((a) => a.name === "same")?.source).toBe("project");
  expect(bothAgents.some((a) => a.name === "user-only")).toBe(true);
  expect(bothAgents.some((a) => a.name === "project-only")).toBe(true);
  expect(userDiscovery.scopes.project).toEqual({
    agents: [],
    markdownFiles: [],
  });
  expect(projectDiscovery.scopes.user).toEqual({
    agents: [],
    markdownFiles: [],
  });
  expect(
    bothDiscovery.scopes.user.agents.map((a) => `${a.name}:${a.source}`).sort(),
  ).toEqual(["same:user", "user-only:user"]);
  expect(
    bothDiscovery.scopes.project.agents
      .map((a) => `${a.name}:${a.source}`)
      .sort(),
  ).toEqual(["project-only:project", "same:project"]);
  expect([...bothDiscovery.scopes.user.markdownFiles].sort()).toEqual([
    "same.md",
    "user-only.md",
  ]);
  expect([...bothDiscovery.scopes.project.markdownFiles].sort()).toEqual([
    "project-only.md",
    "same.md",
  ]);
});

test("discoverAgents tolerates missing, invalid, and unreadable entries", async () => {
  const root = await makeTempDir("pi-subagent-discover-");
  const cwd = path.join(root, "work");
  await mkdir(cwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-without-agents");
  expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
  const agentDirWithFile = path.join(root, "agent-with-file");
  await mkdir(agentDirWithFile, { recursive: true });
  await writeFile(path.join(agentDirWithFile, "agents"), "not a directory");
  process.env.PI_CODING_AGENT_DIR = agentDirWithFile;
  expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
  const agentDirWithBrokenLink = path.join(root, "agent-with-broken-link");
  const agentsDir = path.join(agentDirWithBrokenLink, "agents");
  await mkdir(agentsDir, { recursive: true });
  await symlink(
    path.join(agentsDir, "missing.md"),
    path.join(agentsDir, "broken.md"),
  );
  await writeFile(
    path.join(agentsDir, "missing-description.md"),
    `---
name: invalid
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "invalid-yaml.md"),
    `---
name: [unterminated
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-object.md"),
    `---
- name
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-name.md"),
    `---
name: 1
description: Bad name
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-description.md"),
    `---
name: bad-description
description: 1
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-tools.md"),
    `---
name: bad-tools
description: Bad tools
tools:
  - bash
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-skills.md"),
    `---
name: bad-skills
description: Bad skills
skills:
  - helper
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-thinking.md"),
    `---
name: bad-thinking
description: Bad thinking
thinking: 1
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "empty-options.md"),
    `---
name: empty-options
description: Empty options
tools: " , "
skills:
thinking: louder
---
Prompt`,
  );
  process.env.PI_CODING_AGENT_DIR = agentDirWithBrokenLink;
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agents = discovery.agents;
  expect(agents).toHaveLength(1);
  expect(discovery.scopes.user.agents).toEqual(agents);
  expect(discovery.scopes.project).toEqual({ agents: [], markdownFiles: [] });
  expect([...discovery.scopes.user.markdownFiles].sort()).toEqual([
    "broken.md",
    "empty-options.md",
    "invalid-yaml.md",
    "missing-description.md",
    "non-object.md",
    "non-string-description.md",
    "non-string-name.md",
    "non-string-skills.md",
    "non-string-thinking.md",
    "non-string-tools.md",
  ]);
  expect(agents[0]).toMatchObject({
    name: "empty-options",
    tools: undefined,
    skills: [],
    thinking: undefined,
  });
});

describe("agents.ts error handling and edge cases", () => {
  describe("parseAgentConfig error paths", () => {
    test.each([
      {
        name: "malformed frontmatter returns null",
        fileName: "bad-frontmatter.md",
        yamlBody: `---
this is not valid yaml: [
  unclosed bracket
---
body content`,
        agentName: "bad-frontmatter",
      },
      {
        name: "frontmatter that is array returns null",
        fileName: "array-frontmatter.md",
        yamlBody: `---
- item1
- item2
---
body`,
        agentName: "array-frontmatter",
      },
      {
        name: "tools field that is not string returns null",
        fileName: "bad-tools.md",
        yamlBody: `---
name: bad-tools
description: Tools as number
tools: 123
---
body`,
        agentName: "bad-tools",
      },
      {
        name: "skills field that is not string returns null",
        fileName: "bad-skills.md",
        yamlBody: `---
name: bad-skills
description: Skills as object
skills:
  nested: value
---
body`,
        agentName: "bad-skills",
      },
      {
        name: "thinking field that is not string returns null",
        fileName: "bad-thinking.md",
        yamlBody: `---
name: bad-thinking
description: Thinking as boolean
thinking: true
---
body`,
        agentName: "bad-thinking",
      },
    ])("$name", async (row) => {
      const { agentDir, cwd } = await makeAgentHome();
      const userDir = path.join(agentDir, "agents");
      await writeFile(path.join(userDir, row.fileName), row.yamlBody);
      const discovery = await discoverAgentsAsync(cwd, "user");
      expect(
        discovery.agents.find((a) => a.name === row.agentName),
      ).toBeUndefined();
    });
  });

  describe("loadAgentEntryAsync error paths", () => {
    test("unreadable file returns null and skips agent", async () => {
      const { agentDir, cwd } = await makeAgentHome();
      const userDir = path.join(agentDir, "agents");
      const unreadablePath = path.join(userDir, "unreadable.md");
      await writeFile(
        unreadablePath,
        `---
name: unreadable
description: Cannot read this
---
body`,
      );
      const denied = denyFsAccess(unreadablePath);
      try {
        const discovery = await discoverAgentsAsync(cwd, "user");
        expect(
          discovery.agents.find((a) => a.name === "unreadable"),
        ).toBeUndefined();
      } finally {
        denied.restore();
      }
    });
  });

  describe("readMarkdownDirWithStatusAsync", () => {
    test("null directory returns empty listing with ok true", async () => {
      const result = await readMarkdownDirWithStatusAsync(null);
      expect(result.entries).toEqual([]);
      expect(result.ok).toBe(true);
    });

    test("non-existent directory returns empty listing with ok false", async () => {
      const result = await readMarkdownDirWithStatusAsync(
        "/nonexistent/path/that/does/not/exist",
      );
      expect(result.entries).toEqual([]);
      expect(result.ok).toBe(false);
    });

    test("inaccessible directory returns empty listing with ok false", async () => {
      const { agentDir } = await makeAgentHome();
      const inaccessibleDir = path.join(agentDir, "inaccessible");
      await mkdir(inaccessibleDir, { recursive: true });
      const denied = denyFsAccess(inaccessibleDir);
      try {
        const result = await readMarkdownDirWithStatusAsync(inaccessibleDir);
        expect(result.entries).toEqual([]);
        expect(result.ok).toBe(false);
      } finally {
        denied.restore();
      }
    });
  });

  describe("isDirectoryAsync", () => {
    test("non-existent path returns false", async () => {
      const result = await isDirectoryAsync("/nonexistent/path");
      expect(result).toBe(false);
    });

    test("inaccessible path returns false", async () => {
      const { agentDir } = await makeAgentHome();
      const inaccessiblePath = path.join(agentDir, "inaccessible-stat");
      await mkdir(inaccessiblePath, { recursive: true });
      await mkdir(path.join(inaccessiblePath, "subdir"));
      const denied = denyFsAccess(inaccessiblePath);
      try {
        const result = await isDirectoryAsync(
          path.join(inaccessiblePath, "subdir"),
        );
        expect(result).toBe(false);
      } finally {
        denied.restore();
      }
    });
  });

  describe("formatAgentList", () => {
    test("empty agents list returns none with zero remaining", () => {
      const result = formatAgentList([], 10);
      expect(result.text).toBe("none");
      expect(result.remaining).toBe(0);
    });

    test("agents within maxItems shows all with zero remaining", () => {
      const agents = [
        {
          name: "agent1",
          description: "First agent",
          source: "user" as const,
          systemPrompt: "prompt1",
          filePath: "/path/1",
        },
        {
          name: "agent2",
          description: "Second agent",
          source: "project" as const,
          systemPrompt: "prompt2",
          filePath: "/path/2",
        },
      ];
      const result = formatAgentList(agents, 10);
      expect(result.text).toBe(
        "agent1 (user): First agent; agent2 (project): Second agent",
      );
      expect(result.remaining).toBe(0);
    });

    test("agents exceeding maxItems shows truncated list with remaining count", () => {
      const agents = [
        {
          name: "agent1",
          description: "First agent",
          source: "user" as const,
          systemPrompt: "prompt1",
          filePath: "/path/1",
        },
        {
          name: "agent2",
          description: "Second agent",
          source: "project" as const,
          systemPrompt: "prompt2",
          filePath: "/path/2",
        },
        {
          name: "agent3",
          description: "Third agent",
          source: "user" as const,
          systemPrompt: "prompt3",
          filePath: "/path/3",
        },
      ];
      const result = formatAgentList(agents, 2);
      expect(result.text).toBe(
        "agent1 (user): First agent; agent2 (project): Second agent",
      );
      expect(result.remaining).toBe(1);
    });
  });
});

test("discoverAgentsAsync preserves scope filtering and project override precedence", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await mkdir(projectAgentsDir, { recursive: true });
  await writeFile(
    path.join(userDir, "same.md"),
    `---
name: same
description: User same
---
User prompt`,
  );
  await writeFile(
    path.join(userDir, "user-only.md"),
    `---
name: user-only
description: User only
---
User prompt`,
  );
  await writeFile(
    path.join(projectAgentsDir, "same.md"),
    `---
name: same
description: Project same
---
Project prompt`,
  );
  await writeFile(
    path.join(projectAgentsDir, "project-only.md"),
    `---
name: project-only
description: Project only
---
Project prompt`,
  );
  const userDiscovery = await discoverAgentsAsync(cwd, "user");
  const projectDiscovery = await discoverAgentsAsync(cwd, "project");
  const bothDiscovery = await discoverAgentsAsync(cwd, "both");
  expect(userDiscovery.projectAgentsDir).toBe(projectAgentsDir);
  expect(projectDiscovery.projectAgentsDir).toBe(projectAgentsDir);
  expect(bothDiscovery.projectAgentsDir).toBe(projectAgentsDir);
  expect(userDiscovery.agents.find((a) => a.name === "same")?.source).toBe(
    "user",
  );
  expect(userDiscovery.agents.some((a) => a.name === "project-only")).toBe(
    false,
  );
  expect(projectDiscovery.agents.find((a) => a.name === "same")?.source).toBe(
    "project",
  );
  expect(projectDiscovery.agents.some((a) => a.name === "user-only")).toBe(
    false,
  );
  expect(bothDiscovery.agents.find((a) => a.name === "same")?.source).toBe(
    "project",
  );
  expect(bothDiscovery.agents.some((a) => a.name === "user-only")).toBe(true);
  expect(bothDiscovery.agents.some((a) => a.name === "project-only")).toBe(
    true,
  );
  expect(userDiscovery.scopes.project).toEqual({
    agents: [],
    markdownFiles: [],
  });
  expect(projectDiscovery.scopes.user).toEqual({
    agents: [],
    markdownFiles: [],
  });
  const scopedUserNames = bothDiscovery.scopes.user.agents.map(
    (a) => `${a.name}:${a.source}`,
  );
  expect(scopedUserNames).toContain("same:user");
  expect(scopedUserNames).toContain("user-only:user");
  expect(
    bothDiscovery.scopes.project.agents
      .map((a) => `${a.name}:${a.source}`)
      .sort(),
  ).toEqual(["project-only:project", "same:project"]);
  expect(bothDiscovery.scopes.user.markdownFiles).toContain("same.md");
  expect(bothDiscovery.scopes.user.markdownFiles).toContain("user-only.md");
  expect([...bothDiscovery.scopes.project.markdownFiles].sort()).toEqual([
    "project-only.md",
    "same.md",
  ]);
});

test("discoverAgentsAsync ignores unreadable agent directories", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const root = path.dirname(agentDir);
  const unreadableRoot = path.join(root, "agent-with-unreadable-agents");
  const unreadableAgentsDir = path.join(unreadableRoot, "agents");
  await mkdir(unreadableAgentsDir, { recursive: true });
  await writeFile(
    path.join(unreadableAgentsDir, "hidden.md"),
    `---
name: hidden
description: Hidden
---
Hidden prompt`,
  );
  const denied = denyFsAccess(unreadableAgentsDir);
  process.env.PI_CODING_AGENT_DIR = unreadableRoot;
  try {
    expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
  } finally {
    denied.restore();
  }
});

test("discoverAgentsAsync tolerates missing malformed and symlinked agent files", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const root = path.dirname(agentDir);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-without-agents");
  expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
  const fileRoot = path.join(root, "agent-with-file");
  await mkdir(fileRoot, { recursive: true });
  await writeFile(path.join(fileRoot, "agents"), "not a directory");
  process.env.PI_CODING_AGENT_DIR = fileRoot;
  expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
  const badRoot = path.join(root, "agent-with-bad-files");
  const agentsDir = path.join(badRoot, "agents");
  await mkdir(agentsDir, { recursive: true });
  await symlink(
    path.join(agentsDir, "missing.md"),
    path.join(agentsDir, "broken.md"),
  );
  await writeFile(
    path.join(agentsDir, "missing-description.md"),
    `---
name: invalid
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "invalid-yaml.md"),
    `---
name: [unterminated
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-tools.md"),
    `---
name: bad-tools
description: Bad tools
tools:
  - bash
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "target.txt"),
    `---
name: linked
description: Linked agent
tools: bash, read
skills: helper, reviewer
thinking: HIGH
---
Linked prompt`,
  );
  await symlink(
    path.join(agentsDir, "target.txt"),
    path.join(agentsDir, "linked.md"),
  );
  process.env.PI_CODING_AGENT_DIR = badRoot;
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agents = discovery.agents;
  expect(agents).toHaveLength(1);
  expect(discovery.scopes.user.agents).toEqual(agents);
  expect(discovery.scopes.project).toEqual({ agents: [], markdownFiles: [] });
  expect([...discovery.scopes.user.markdownFiles].sort()).toEqual([
    "broken.md",
    "invalid-yaml.md",
    "linked.md",
    "missing-description.md",
    "non-string-tools.md",
  ]);
  expect(agents[0]).toMatchObject({
    name: "linked",
    description: "Linked agent",
    tools: ["bash", "read"],
    skills: ["helper", "reviewer"],
    thinking: "high",
    systemPrompt: "Linked prompt",
    source: "user",
    filePath: path.join(agentsDir, "linked.md"),
  });
});
