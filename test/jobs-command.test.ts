import { expect, test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { jobsCommandHandler } from "../src/jobs-command.js";
import {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  patchProgressState,
} from "../src/progress.js";
import { clearRunJobsForTests, registerRunJob } from "../src/run-registry.js";
import { setupHooks } from "./helpers.js";

setupHooks();

function makeCtx(notify: (msg: string) => void): ExtensionCommandContext {
  return {
    cwd: "/tmp",
    ui: { notify } as ExtensionCommandContext["ui"],
  } as ExtensionCommandContext;
}

test("/jobs empty board shows no-jobs message", async () => {
  clearRunJobsForTests();
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs shows active running jobs", async () => {
  clearRunJobsForTests();
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
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  expect(output).toContain("test-agent");
  expect(output).toContain("test-instance");
  expect(output).toContain("[running]");
  expect(output).toContain("3 tools");
  clearProgressState(rid);
});

test("/jobs shows completed jobs after active ones", async () => {
  clearRunJobsForTests();
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
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  const activeIdx = output.indexOf("active-agent");
  const doneIdx = output.indexOf("done-agent");
  expect(activeIdx).toBeGreaterThan(-1);
  expect(doneIdx).toBeGreaterThan(-1);
  expect(activeIdx).toBeLessThan(doneIdx);
  clearProgressState(doneRid);
  clearProgressState(activeRid);
});

test("/jobs shows cancelled and error jobs", async () => {
  clearRunJobsForTests();
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
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  expect(output).toContain("[error]");
  expect(output).toContain("[cancelled]");
  expect(output).toContain("something broke");
  expect(output).toContain("user aborted");
  clearProgressState(errRid);
  clearProgressState(cancelRid);
});

test("/jobs ignores arguments", async () => {
  clearRunJobsForTests();
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "some garbage args",
  );
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs active job not in progress store is skipped", async () => {
  clearRunJobsForTests();
  registerRunJob({
    requestId: "orphan-job",
    agentName: "orphan-agent",
    instanceName: "orphan-inst",
    controller: new AbortController(),
    startedAt: Date.now(),
  });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  // No progress state for orphan-job, so board should be empty
  expect(notices).toEqual(["No /run jobs in this session."]);
});

test("/jobs completed job also in active registry excluded from completed list", async () => {
  clearRunJobsForTests();
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
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toHaveLength(1);
  const output = notices[0] ?? "";
  expect(output).toContain("dual-agent");
  // Appears once in active section, not duplicated in completed
  const firstIdx = output.indexOf("dual-agent");
  const lastIdx = output.lastIndexOf("dual-agent");
  expect(firstIdx).toBe(lastIdx);
  clearProgressState(rid);
});

test("/jobs sorts jobs within same category by startTime descending", async () => {
  clearRunJobsForTests();
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
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  const oldIdx = output.indexOf("old-agent");
  const newIdx = output.indexOf("new-agent");
  expect(newIdx).toBeLessThan(oldIdx);
  clearProgressState(rid1);
  clearProgressState(rid2);
});

test("/jobs truncates long final output in board", async () => {
  clearRunJobsForTests();
  const rid = "long-output-job";
  createProgressState(rid, "long-agent", "task", "inst");
  const longText = "A".repeat(90);
  finalizeProgressState(rid, longText);
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  // Full 90-char string must not appear; truncation marker must be present
  expect(output).not.toContain("A".repeat(90));
  expect(output).toContain("A...");
  clearProgressState(rid);
});

test("/jobs skips zombie running jobs not in active registry", async () => {
  clearRunJobsForTests();
  const rid = "zombie-job";
  createProgressState(rid, "zombie-agent", "task", "zombie-inst");
  // State is running but NOT in the active job registry — handler must skip it
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  expect(notices).toEqual(["No /run jobs in this session."]);
  clearProgressState(rid);
});

test("/jobs uses singular 'tool' label when toolCount is 1", async () => {
  clearRunJobsForTests();
  const rid = "singular-tool-job";
  createProgressState(rid, "agent-one", "task", "inst");
  patchProgressState(rid, { toolCount: 1 });
  finalizeProgressState(rid, "done");
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("1 tool ");
  expect(output).not.toContain("1 tools");
  clearProgressState(rid);
});

test("/jobs uses plural 'tools' label when toolCount is not 1", async () => {
  clearRunJobsForTests();
  const rid = "plural-tools-job";
  createProgressState(rid, "agent-many", "task", "inst");
  patchProgressState(rid, { toolCount: 0 });
  finalizeProgressState(rid, "done");
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("0 tools");
  clearProgressState(rid);
});

test("/jobs shows errorText body for error state when no finalOutput", async () => {
  clearRunJobsForTests();
  const rid = "error-body-job";
  createProgressState(rid, "err-agent", "task", "inst");
  failProgressState(rid, "disk full");
  patchProgressState(rid, { toolCount: 0 });
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).toContain("disk full");
  clearProgressState(rid);
});

test("/jobs does not truncate body text at exactly 80 chars", async () => {
  clearRunJobsForTests();
  const rid = "exact-80-job";
  createProgressState(rid, "agent-80", "task", "inst");
  const exactText = "B".repeat(80);
  finalizeProgressState(rid, exactText);
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).not.toContain("B...");
  clearProgressState(rid);
});

test("/jobs truncates body text at 81 chars", async () => {
  clearRunJobsForTests();
  const rid = "81-char-job";
  createProgressState(rid, "agent-81", "task", "inst");
  const text81 = "C".repeat(81);
  finalizeProgressState(rid, text81);
  const notices: string[] = [];
  await jobsCommandHandler(
    makeCtx((msg) => notices.push(msg)),
    "",
  );
  const output = notices[0] ?? "";
  expect(output).not.toContain("C".repeat(81));
  expect(output).toContain("C...");
  clearProgressState(rid);
});
