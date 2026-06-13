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
