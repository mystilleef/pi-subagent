import { beforeEach, expect, test } from "bun:test";
import { jobsCommandHandler } from "../src/orchestration/jobs-command.js";
import {
  registerRunJob,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  patchProgressState,
  resetProgressStore,
} from "../src/progress/progress.js";
import { makeCommandContext, setupHooks } from "./helpers.js";

setupHooks();

beforeEach(() => {
  resetRunRegistry();
  resetProgressStore();
});

test("/jobs empty board shows no-jobs message", async () => {
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs shows active running jobs", async () => {
  const rid = "runs-active-test";
  createProgressState(rid, "test-agent", "do something", "test-instance");
  patchProgressState(rid, {
    toolCount: 3,
    contextTokens: 4000,
    contextWindowTokens: 10000,
  });
  registerRunJob({
    requestId: rid,
    agentName: "test-agent",
    instanceName: "test-instance",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  expect(output).toContain("test-agent");
  expect(output).toContain("test-instance");
  expect(output).toContain("[running]");
  expect(output).toContain("3 tools");
});

test("/jobs notification width is two less than board width", async () => {
  const rid = "width-job";
  createProgressState(rid, "width-agent", "task", "inst");
  registerRunJob({
    requestId: rid,
    agentName: "width-agent",
    instanceName: "inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg), 122),
    "",
  );
  const output = notices[0] ?? "";
  expect(output.match(/─+/)?.[0]?.length).toBe(109);
});

test("/jobs shows status sections after active jobs", async () => {
  const doneRid = "runs-done-test";
  createProgressState(doneRid, "done-agent", "finished task", "done-inst");
  finalizeProgressState(doneRid, "completed task");
  patchProgressState(doneRid, {
    toolCount: 1,
    contextTokens: 100,
    contextWindowTokens: 1000,
  });
  const activeRid = "runs-active-2";
  createProgressState(
    activeRid,
    "active-agent",
    "still running",
    "active-inst",
  );
  patchProgressState(activeRid, {
    toolCount: 5,
    contextTokens: 2000,
    contextWindowTokens: 8000,
  });
  registerRunJob({
    requestId: activeRid,
    agentName: "active-agent",
    instanceName: "active-inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  const activeIdx = output.indexOf("active-agent");
  const doneIdx = output.indexOf("done-agent");
  expect(activeIdx).toBeGreaterThan(-1);
  expect(doneIdx).toBeGreaterThan(-1);
  expect(activeIdx).toBeLessThan(doneIdx);
  expect(output).toContain("ACTIVE (1)");
  expect(output).toContain("SUCCEEDED (1)");
  expect(output).not.toContain("COMPLETED");
});

test("/jobs shows cancelled and error jobs", async () => {
  const errRid = "runs-error-test";
  createProgressState(errRid, "err-agent", "failed task", "err-inst");
  failProgressState(errRid, "something broke");
  patchProgressState(errRid, { toolCount: 2 });
  const cancelRid = "runs-cancel-test";
  createProgressState(
    cancelRid,
    "cancel-agent",
    "cancelled task",
    "cancel-inst",
  );
  cancelProgressState(cancelRid, "user aborted");
  patchProgressState(cancelRid, { toolCount: 0 });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  expect(output).toContain("FAILED (1)");
  expect(output).toContain("CANCELLED (1)");
  expect(output).toContain("[error]");
  expect(output).toContain("[cancelled]");
  expect(output).toContain("something broke");
  expect(output).toContain("user aborted");
  expect(output).not.toContain("COMPLETED");
});

test("/jobs ignores arguments", async () => {
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "some garbage args",
  );
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs active job not in progress store is skipped", async () => {
  registerRunJob({
    requestId: "orphan-job",
    agentName: "orphan-agent",
    instanceName: "orphan-inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  // No progress state for orphan-job, so board should be empty
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs completed job also in active registry excluded from completed list", async () => {
  const rid = "dual-state-job";
  createProgressState(rid, "dual-agent", "task", "dual-inst");
  finalizeProgressState(rid, "done output");
  registerRunJob({
    requestId: rid,
    agentName: "dual-agent",
    instanceName: "dual-inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  expect(output).toContain("dual-agent");
  // Appears once in active section, not duplicated in completed
  const firstIdx = output.indexOf("dual-agent");
  const lastIdx = output.lastIndexOf("dual-agent");
  expect(firstIdx).toBe(lastIdx);
});

test("/jobs sorts jobs within same category by startTime descending", async () => {
  const rid1 = "job-old";
  const rid2 = "job-new";
  const now = Date.now();
  createProgressState(rid1, "old-agent", "task", "inst");
  createProgressState(rid2, "new-agent", "task", "inst");
  patchProgressState(rid1, { startTime: now - 5000 });
  patchProgressState(rid2, { startTime: now });
  registerRunJob({
    requestId: rid1,
    agentName: "old-agent",
    instanceName: "inst",
    controller: new AbortController(),
    startedAt: now - 5000,
  });
  registerRunJob({
    requestId: rid2,
    agentName: "new-agent",
    instanceName: "inst",
    controller: new AbortController(),
    startedAt: now,
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  const oldIdx = output.indexOf("old-agent");
  const newIdx = output.indexOf("new-agent");
  expect(newIdx).toBeLessThan(oldIdx);
});

test("/jobs truncates long final output in board", async () => {
  const rid = "long-output-job";
  createProgressState(rid, "long-agent", "task", "inst");
  const longText = "A".repeat(121);
  finalizeProgressState(rid, longText);
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).not.toContain(longText);
  expect(output).toContain("…");
});

test("/jobs skips zombie running jobs not in active registry", async () => {
  const rid = "zombie-job";
  createProgressState(rid, "zombie-agent", "task", "zombie-inst");
  // State is running but NOT in the active job registry — handler must skip it
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs uses singular 'tool' label when toolCount is 1", async () => {
  const rid = "singular-tool-job";
  createProgressState(rid, "agent-one", "task", "inst");
  patchProgressState(rid, { toolCount: 1 });
  finalizeProgressState(rid, "done");
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg), 200),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("1 tool ");
  expect(output).not.toContain("1 tools");
});

test("/jobs uses plural 'tools' label when toolCount is not 1", async () => {
  const rid = "plural-tools-job";
  createProgressState(rid, "agent-many", "task", "inst");
  patchProgressState(rid, { toolCount: 0 });
  finalizeProgressState(rid, "done");
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg), 200),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("0 tools");
});

test("/jobs shows errorText body for error state when no finalOutput", async () => {
  const rid = "error-body-job";
  createProgressState(rid, "err-agent", "task", "inst");
  failProgressState(rid, "disk full");
  patchProgressState(rid, { toolCount: 0 });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("disk full");
});

test("/jobs does not truncate body text at exactly 120 chars", async () => {
  const rid = "exact-120-job";
  createProgressState(rid, "agent-120", "task", "inst");
  const exactText = "B".repeat(120);
  finalizeProgressState(rid, exactText);
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg), 200),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("B".repeat(60));
});

test("/jobs truncates body text at 121 chars", async () => {
  const rid = "121-char-job";
  createProgressState(rid, "agent-121", "task", "inst");
  const text121 = "C".repeat(121);
  finalizeProgressState(rid, text121);
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCommandContext((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).not.toContain(text121);
  expect(output).toContain("…");
});
