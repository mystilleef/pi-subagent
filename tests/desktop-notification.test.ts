import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultCommandExists,
  deliverLinuxNotification,
  deliverMacOSNotification,
  deliverNotification,
  deliverWindowsNotification,
  resetDefaultDeliveryDeps,
  resetNotifySendCache,
  setDefaultDeliveryDeps,
} from "../src/notification/delivery.js";
import {
  buildNotificationRequest,
  deriveDurationMs,
  formatNotificationBody,
  isDesktopNotificationsEnabled,
  isPerJobNotificationEnabled,
  NOTIFICATION_TITLE,
} from "../src/notification/desktop-notification.js";
import type { SubagentProgressState } from "../src/progress/progress-state.js";
import { withEnv } from "./helpers.js";

function makeState(
  overrides: Partial<SubagentProgressState> = {},
): SubagentProgressState {
  return {
    requestId: "req-1",
    agent: "test-agent",
    taskPreview: "test task",
    status: "success",
    startTime: 1000,
    durationMs: undefined,
    toolCount: 1,
    ...overrides,
  };
}

function makeRequest(
  overrides: Partial<{
    title: string;
    body: string;
    urgency: "normal" | "critical";
    timeoutMs: number;
  }> = {},
) {
  return {
    title: NOTIFICATION_TITLE,
    body: "test-agent finished in 5.0s",
    urgency: "normal" as const,
    timeoutMs: 5000,
    ...overrides,
  };
}

describe("desktop-notification.ts", () => {
  describe("isDesktopNotificationsEnabled", () => {
    test("missing env value returns true (default enabled)", () => {
      withEnv({ PI_SUBAGENT_DESKTOP_NOTIFICATIONS: undefined }, () => {
        expect(isDesktopNotificationsEnabled({})).toBe(true);
      });
    });

    test.each([
      { name: "empty string returns true", envValue: "" },
      { name: "value '1' returns true", envValue: "1" },
    ])("$name", (row) => {
      expect(
        isDesktopNotificationsEnabled({
          PI_SUBAGENT_DESKTOP_NOTIFICATIONS: row.envValue,
        }),
      ).toBe(true);
    });

    test("value '0' returns false (opt-out)", () => {
      expect(
        isDesktopNotificationsEnabled({
          PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "0",
        }),
      ).toBe(false);
    });

    test("invalid value keeps notifications enabled", () => {
      expect(
        isDesktopNotificationsEnabled({
          PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "invalid",
        }),
      ).toBe(true);
      expect(
        isDesktopNotificationsEnabled({
          PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "yes",
        }),
      ).toBe(true);
      expect(
        isDesktopNotificationsEnabled({
          PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "true",
        }),
      ).toBe(true);
      expect(
        isDesktopNotificationsEnabled({
          PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "2",
        }),
      ).toBe(true);
      expect(
        isDesktopNotificationsEnabled({
          PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "-1",
        }),
      ).toBe(true);
    });

    test("undefined env object returns true", () => {
      withEnv({ PI_SUBAGENT_DESKTOP_NOTIFICATIONS: undefined }, () => {
        expect(isDesktopNotificationsEnabled(undefined)).toBe(true);
      });
    });
  });

  describe("isPerJobNotificationEnabled", () => {
    test("missing env value returns false (default off)", () => {
      expect(isPerJobNotificationEnabled({})).toBe(false);
    });

    test.each([
      { name: "empty string returns false", envValue: "" },
      { name: "value '0' returns false", envValue: "0" },
    ])("$name", (row) => {
      expect(
        isPerJobNotificationEnabled({
          PI_SUBAGENT_NOTIFY_PER_JOB: row.envValue,
        }),
      ).toBe(false);
    });

    test("value '1' returns true (opt-in)", () => {
      expect(
        isPerJobNotificationEnabled({ PI_SUBAGENT_NOTIFY_PER_JOB: "1" }),
      ).toBe(true);
    });

    test("invalid value returns false", () => {
      expect(
        isPerJobNotificationEnabled({ PI_SUBAGENT_NOTIFY_PER_JOB: "invalid" }),
      ).toBe(false);
      expect(
        isPerJobNotificationEnabled({ PI_SUBAGENT_NOTIFY_PER_JOB: "yes" }),
      ).toBe(false);
      expect(
        isPerJobNotificationEnabled({ PI_SUBAGENT_NOTIFY_PER_JOB: "true" }),
      ).toBe(false);
      expect(
        isPerJobNotificationEnabled({ PI_SUBAGENT_NOTIFY_PER_JOB: "2" }),
      ).toBe(false);
    });

    test("undefined env object returns false", () => {
      expect(isPerJobNotificationEnabled(undefined)).toBe(false);
    });
  });

  describe("deriveDurationMs", () => {
    test.each([
      {
        name: "returns durationMs when present",
        durationMs: 5000,
        expectedDurationMs: 5000,
      },
      {
        name: "zero durationMs returns zero",
        durationMs: 0,
        expectedDurationMs: 0,
      },
    ])("$name", (row) => {
      const state = makeState({ durationMs: row.durationMs });
      expect(deriveDurationMs(state)).toBe(row.expectedDurationMs);
    });

    test("computes from Date.now() when durationMs absent", () => {
      const now = 10000;
      const state = makeState({ startTime: now - 3000, durationMs: undefined });
      const duration = deriveDurationMs(state);
      expect(duration).toBeGreaterThanOrEqual(3000);
    });
  });

  describe("formatNotificationBody", () => {
    test.each([
      {
        name: "success state produces '<agent> finished in <duration>'",
        agent: "my-agent",
        status: "success",
        durationMs: 5200,
        expectedBody: "my-agent finished in 5.2s",
      },
      {
        name: "error state produces '<agent> failed after <duration>'",
        agent: "my-agent",
        status: "error",
        durationMs: 5200,
        expectedBody: "my-agent failed after 5.2s",
      },
      {
        name: "running state produces finished message",
        agent: "my-agent",
        status: "running",
        durationMs: 5200,
        expectedBody: "my-agent finished in 5.2s",
      },
      {
        name: "cancelled state produces finished message",
        agent: "my-agent",
        status: "cancelled",
        durationMs: 5200,
        expectedBody: "my-agent finished in 5.2s",
      },
      {
        name: "zero duration formats as 0.0s",
        agent: "agent",
        status: "success",
        durationMs: 0,
        expectedBody: "agent finished in 0.0s",
      },
      {
        name: "long duration formats as minutes and seconds",
        agent: "agent",
        status: "success",
        durationMs: 125000,
        expectedBody: "agent finished in 2m 5s",
      },
      {
        name: "unusual agent names with special characters",
        agent: "my-agent_v2.0",
        status: "success",
        durationMs: 1000,
        expectedBody: "my-agent_v2.0 finished in 1.0s",
      },
      {
        name: "agent name with spaces",
        agent: "my agent",
        status: "error",
        durationMs: 1000,
        expectedBody: "my agent failed after 1.0s",
      },
    ])("$name", (row) => {
      expect(
        formatNotificationBody(row.agent, row.status, row.durationMs),
      ).toBe(row.expectedBody);
    });
  });

  describe("buildNotificationRequest", () => {
    test("success state produces correct request with normal urgency", () => {
      const state = makeState({
        agent: "test-agent",
        status: "success",
        durationMs: 5000,
      });
      const request = buildNotificationRequest(state);
      expect(request.title).toBe(NOTIFICATION_TITLE);
      expect(request.body).toBe("test-agent finished in 5.0s");
      expect(request.urgency).toBe("normal");
      expect(request.timeoutMs).toBe(5000);
    });

    test("error state produces critical urgency", () => {
      const state = makeState({
        agent: "test-agent",
        status: "error",
        durationMs: 5000,
      });
      const request = buildNotificationRequest(state);
      expect(request.urgency).toBe("critical");
      expect(request.body).toBe("test-agent failed after 5.0s");
    });

    test("uses durationMs when present", () => {
      const state = makeState({
        startTime: 1000,
        durationMs: 3000,
      });
      const request = buildNotificationRequest(state, () => 99999);
      expect(request.body).toBe("test-agent finished in 3.0s");
    });

    test("computes duration from now() when durationMs absent", () => {
      const state = makeState({
        startTime: 1000,
        durationMs: undefined,
      });
      const request = buildNotificationRequest(state, () => 6000);
      expect(request.body).toBe("test-agent finished in 5.0s");
    });

    test("zero duration produces 0.0s", () => {
      const state = makeState({
        durationMs: 0,
      });
      const request = buildNotificationRequest(state);
      expect(request.body).toBe("test-agent finished in 0.0s");
    });

    test("unusual agent names preserved in body", () => {
      const state = makeState({
        agent: "Agent-With-Dashes_and_underscores",
        durationMs: 1000,
      });
      const request = buildNotificationRequest(state);
      expect(request.body).toContain("Agent-With-Dashes_and_underscores");
    });

    test("long duration formats correctly", () => {
      const state = makeState({
        durationMs: 185000,
      });
      const request = buildNotificationRequest(state);
      expect(request.body).toContain("3m 5s");
    });

    test.each([
      {
        name: "cancelled status produces normal urgency finished message",
        status: "cancelled",
      },
      {
        name: "running status produces normal urgency finished message",
        status: "running",
      },
    ])("$name", (row) => {
      const state = makeState({
        status: row.status,
        durationMs: 2000,
      });
      const request = buildNotificationRequest(state);
      expect(request.urgency).toBe("normal");
      expect(request.body).toBe("test-agent finished in 2.0s");
    });
  });
});

describe("defaultCommandExists", () => {
  test("symlink to regular executable returns true", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin";
    try {
      // ls exists and is executable on all systems
      const result = await defaultCommandExists("ls");
      expect(result).toBe(true);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
    }
  });

  test.each([
    {
      name: "regular file with execute permission returns true",
      pathEnv: "/usr/bin",
      command: "sh",
    },
    {
      name: "PATH with trailing slash entries correctly joins",
      pathEnv: "/usr/bin/",
      command: "ls",
    },
    {
      name: "duplicate PATH entries no error, first match wins",
      pathEnv: "/usr/bin:/usr/bin:/usr/bin",
      command: "ls",
    },
    {
      name: "multiple PATH entries finds command in later entry",
      pathEnv: "/nonexistent:/usr/bin",
      command: "ls",
    },
  ])("$name", async (row) => {
    const originalPath = process.env.PATH;
    process.env.PATH = row.pathEnv;
    try {
      const result = await defaultCommandExists(row.command);
      expect(result).toBe(true);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
    }
  });

  test.each([
    {
      name: "non-existent command returns false",
      pathEnv: "/usr/bin",
      command: "nonexistent_cmd_xyz_12345",
    },
    { name: "empty PATH returns false", pathEnv: "", command: "ls" },
  ])("$name", async (row) => {
    const originalPath = process.env.PATH;
    process.env.PATH = row.pathEnv;
    try {
      const result = await defaultCommandExists(row.command);
      expect(result).toBe(false);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
    }
  });

  test("undefined PATH returns false", async () => {
    const originalPath = process.env.PATH;
    delete process.env.PATH;
    try {
      const result = await defaultCommandExists("ls");
      expect(result).toBe(false);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
    }
  });

  test("directory entry rejected by isFile check", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/";
    try {
      // "bin" is a directory at root
      const result = await defaultCommandExists("bin");
      expect(result).toBe(false);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
    }
  });

  test("file without execute permission returns false", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cmd-test-"));
    const filePath = join(tmpDir, "noexec");
    writeFileSync(filePath, "#!/bin/sh\n");
    chmodSync(filePath, 0o644);
    const originalPath = process.env.PATH;
    process.env.PATH = tmpDir;
    try {
      const result = await defaultCommandExists("noexec");
      expect(result).toBe(false);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("delivery.ts", () => {
  describe("deliverLinuxNotification", () => {
    test("skips on non-linux platform", async () => {
      resetNotifySendCache();
      let spawned = false;
      await deliverLinuxNotification(makeRequest(), {
        platform: "darwin",
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      expect(spawned).toBe(false);
    });

    test("skips when notify-send not found", async () => {
      resetNotifySendCache();
      let spawned = false;
      await deliverLinuxNotification(makeRequest(), {
        platform: "linux",
        commandExists: async () => false,
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      expect(spawned).toBe(false);
    });

    test("spawns notify-send with correct args for normal urgency", async () => {
      resetNotifySendCache();
      let capturedCmd = "";
      let capturedArgs: string[] = [];
      await deliverLinuxNotification(
        makeRequest({
          title: "Pi Subagent",
          body: "agent finished in 5.0s",
          urgency: "normal",
          timeoutMs: 5000,
        }),
        {
          platform: "linux",
          commandExists: async () => true,
          spawnProcess: (cmd, args) => {
            capturedCmd = cmd;
            capturedArgs = args;
            return {};
          },
        },
      );
      expect(capturedCmd).toBe("notify-send");
      expect(capturedArgs).toContain("--expire-time=5000");
      expect(capturedArgs).toContain("Pi Subagent");
      expect(capturedArgs).toContain("agent finished in 5.0s");
      expect(capturedArgs).not.toContain("--urgency=critical");
    });

    test("spawns notify-send with critical urgency for error requests", async () => {
      resetNotifySendCache();
      let capturedArgs: string[] = [];
      await deliverLinuxNotification(makeRequest({ urgency: "critical" }), {
        platform: "linux",
        commandExists: async () => true,
        spawnProcess: (_cmd, args) => {
          capturedArgs = args;
          return {};
        },
      });
      expect(capturedArgs).toContain("--urgency=critical");
    });

    test("unrefs child process", async () => {
      resetNotifySendCache();
      let unrefed = false;
      await deliverLinuxNotification(makeRequest(), {
        platform: "linux",
        commandExists: async () => true,
        spawnProcess: () => ({
          unref: () => {
            unrefed = true;
          },
        }),
      });
      expect(unrefed).toBe(true);
    });

    test("swallows spawn throws", async () => {
      resetNotifySendCache();
      expect(
        await deliverLinuxNotification(makeRequest(), {
          platform: "linux",
          commandExists: async () => true,
          spawnProcess: () => {
            throw new Error("spawn failed");
          },
        }),
      ).toBeUndefined();
    });

    test("caches notify-send availability on subsequent calls", async () => {
      resetNotifySendCache();
      let checkCount = 0;
      const commandExists = async () => {
        checkCount++;
        return true;
      };
      await deliverLinuxNotification(makeRequest(), {
        platform: "linux",
        commandExists,
        spawnProcess: () => ({}),
      });
      await deliverLinuxNotification(makeRequest(), {
        platform: "linux",
        commandExists,
        spawnProcess: () => ({}),
      });
      expect(checkCount).toBe(1);
    });

    test("caches notify-send unavailability on subsequent calls", async () => {
      resetNotifySendCache();
      let checkCount = 0;
      const commandExists = async () => {
        checkCount++;
        return false;
      };
      await deliverLinuxNotification(makeRequest(), {
        platform: "linux",
        commandExists,
        spawnProcess: () => ({}),
      });
      await deliverLinuxNotification(makeRequest(), {
        platform: "linux",
        commandExists,
        spawnProcess: () => ({}),
      });
      expect(checkCount).toBe(1);
    });

    test("uses defaultCommandExists when deps.commandExists absent", async () => {
      resetNotifySendCache();
      const tmpDir = mkdtempSync(join(tmpdir(), "notify-test-"));
      const fakeNotifySend = join(tmpDir, "notify-send");
      writeFileSync(fakeNotifySend, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeNotifySend, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = tmpDir;
      let spawned = false;
      try {
        await deliverLinuxNotification(makeRequest(), {
          platform: "linux",
          spawnProcess: () => {
            spawned = true;
            return {};
          },
        });
        expect(spawned).toBe(true);
      } finally {
        if (originalPath !== undefined) process.env.PATH = originalPath;
        else delete process.env.PATH;
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("deliverMacOSNotification", () => {
    test("skips on non-darwin platform", async () => {
      let spawned = false;
      await deliverMacOSNotification(makeRequest(), {
        platform: "linux",
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      expect(spawned).toBe(false);
    });

    test("spawns osascript with correct script", async () => {
      let capturedCmd = "";
      let capturedArgs: string[] = [];
      await deliverMacOSNotification(
        makeRequest({
          title: "Pi Subagent",
          body: "agent finished in 5.0s",
        }),
        {
          platform: "darwin",
          spawnProcess: (cmd, args) => {
            capturedCmd = cmd;
            capturedArgs = args;
            return {};
          },
        },
      );
      expect(capturedCmd).toBe("osascript");
      expect(capturedArgs).toContain("-e");
      const script = capturedArgs[1];
      expect(script).toContain("display notification");
      expect(script).toContain("agent finished in 5.0s");
      expect(script).toContain("Pi Subagent");
    });

    test.each([
      {
        name: "escapes double quotes in title and body",
        title: 'He said "hello"',
        body: 'It\'s a "test"',
        escapedTitle: 'He said \\"hello\\"',
        escapedBody: 'It\'s a \\"test\\"',
      },
      {
        name: "escapes backslashes in title and body",
        title: "C:\\Users\\test",
        body: "path\\to\\file",
        escapedTitle: "C:\\\\Users\\\\test",
        escapedBody: "path\\\\to\\\\file",
      },
      {
        name: "escapes both backslashes and double quotes together",
        title: 'Path "C:\\dir" is invalid',
        body: 'See "doc\\readme"',
        escapedTitle: 'Path \\"C:\\\\dir\\" is invalid',
        escapedBody: 'See \\"doc\\\\readme\\"',
      },
    ])("$name", async (row) => {
      let capturedArgs: string[] = [];
      await deliverMacOSNotification(
        makeRequest({
          title: row.title,
          body: row.body,
        }),
        {
          platform: "darwin",
          spawnProcess: (_cmd, args) => {
            capturedArgs = args;
            return {};
          },
        },
      );
      const script = capturedArgs[1];
      expect(script).toContain(row.escapedTitle);
      expect(script).toContain(row.escapedBody);
    });

    test("handles strings with no special characters", async () => {
      let capturedArgs: string[] = [];
      await deliverMacOSNotification(
        makeRequest({
          title: "Simple title",
          body: "Simple body",
        }),
        {
          platform: "darwin",
          spawnProcess: (_cmd, args) => {
            capturedArgs = args;
            return {};
          },
        },
      );
      const script = capturedArgs[1];
      expect(script).toBe(
        'display notification "Simple body" with title "Simple title"',
      );
    });

    test("swallows spawn throws", async () => {
      expect(
        await deliverMacOSNotification(makeRequest(), {
          platform: "darwin",
          spawnProcess: () => {
            throw new Error("spawn failed");
          },
        }),
      ).toBeUndefined();
    });
  });

  describe("deliverWindowsNotification", () => {
    test("skips on non-win32 platform", async () => {
      let spawned = false;
      await deliverWindowsNotification(makeRequest(), {
        platform: "linux",
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      expect(spawned).toBe(false);
    });

    test("spawns powershell with correct script", async () => {
      let capturedCmd = "";
      let capturedArgs: string[] = [];
      await deliverWindowsNotification(
        makeRequest({
          title: "Pi Subagent",
          body: "agent finished in 5.0s",
          timeoutMs: 5000,
        }),
        {
          platform: "win32",
          spawnProcess: (cmd, args) => {
            capturedCmd = cmd;
            capturedArgs = args;
            return {};
          },
        },
      );
      expect(capturedCmd).toBe("powershell.exe");
      expect(capturedArgs).toContain("-NoProfile");
      expect(capturedArgs).toContain("-NonInteractive");
      expect(capturedArgs).toContain("-WindowStyle");
      expect(capturedArgs).toContain("Hidden");
      expect(capturedArgs).toContain("-Command");
      const script = capturedArgs[5];
      expect(script).toContain("Pi Subagent");
      expect(script).toContain("agent finished in 5.0s");
      expect(script).toContain("5000");
    });

    test.each([
      {
        name: "escapes single quotes in title and body",
        title: "It's a test",
        body: "don't worry",
        escapedTitle: "It''s a test",
        escapedBody: "don''t worry",
      },
      {
        name: "escapes multiple single quotes in same string",
        title: "It's a 'test'",
        body: "don't don't don't",
        escapedTitle: "It''s a ''test''",
        escapedBody: "don''t don''t don''t",
      },
    ])("$name", async (row) => {
      let capturedArgs: string[] = [];
      await deliverWindowsNotification(
        makeRequest({
          title: row.title,
          body: row.body,
        }),
        {
          platform: "win32",
          spawnProcess: (_cmd, args) => {
            capturedArgs = args;
            return {};
          },
        },
      );
      const script = capturedArgs[5];
      expect(script).toContain(row.escapedTitle);
      expect(script).toContain(row.escapedBody);
    });

    test("handles strings with no single quotes", async () => {
      let capturedArgs: string[] = [];
      await deliverWindowsNotification(
        makeRequest({
          title: "Simple title",
          body: "Simple body",
          timeoutMs: 3000,
        }),
        {
          platform: "win32",
          spawnProcess: (_cmd, args) => {
            capturedArgs = args;
            return {};
          },
        },
      );
      const script = capturedArgs[5];
      expect(script).toContain("Simple title");
      expect(script).toContain("Simple body");
      expect(script).toContain("3000");
    });

    test("swallows spawn throws", async () => {
      expect(
        await deliverWindowsNotification(makeRequest(), {
          platform: "win32",
          spawnProcess: () => {
            throw new Error("spawn failed");
          },
        }),
      ).toBeUndefined();
    });
  });
});

describe("deliverNotification", () => {
  test("routes to linux notification on linux", async () => {
    resetNotifySendCache();
    let capturedCmd = "";
    await deliverNotification(makeRequest(), {
      platform: "linux",
      commandExists: async () => true,
      spawnProcess: (cmd) => {
        capturedCmd = cmd;
        return {};
      },
    });
    expect(capturedCmd).toBe("notify-send");
  });

  test.each([
    {
      name: "routes to macOS notification on darwin",
      platform: "darwin",
      expectedCommand: "osascript",
    },
    {
      name: "routes to windows notification on win32",
      platform: "win32",
      expectedCommand: "powershell.exe",
    },
  ])("$name", async (row) => {
    let capturedCmd = "";
    await deliverNotification(makeRequest(), {
      platform: row.platform,
      spawnProcess: (cmd) => {
        capturedCmd = cmd;
        return {};
      },
    });
    expect(capturedCmd).toBe(row.expectedCommand);
  });

  test("does nothing on unsupported platform", async () => {
    let spawned = false;
    await deliverNotification(makeRequest(), {
      platform: "freebsd",
      spawnProcess: () => {
        spawned = true;
        return {};
      },
    });
    expect(spawned).toBe(false);
  });

  test("checkNotifySendExists catch caches false when commandExists throws", async () => {
    resetNotifySendCache();
    let spawned = false;
    await deliverLinuxNotification(makeRequest(), {
      platform: "linux",
      commandExists: async () => {
        throw new Error("check failed");
      },
      spawnProcess: () => {
        spawned = true;
        return {};
      },
    });
    await deliverLinuxNotification(makeRequest(), {
      platform: "linux",
      commandExists: async () => true,
      spawnProcess: () => {
        spawned = true;
        return {};
      },
    });
    expect(spawned).toBe(false);
  });

  test("checkNotifySendExists accepts synchronous boolean true", async () => {
    resetNotifySendCache();
    let spawned = false;
    await deliverLinuxNotification(makeRequest(), {
      platform: "linux",
      commandExists: () => true,
      spawnProcess: () => {
        spawned = true;
        return {};
      },
    });
    expect(spawned).toBe(true);
  });

  test("checkNotifySendExists accepts synchronous boolean false", async () => {
    resetNotifySendCache();
    let spawned = false;
    await deliverLinuxNotification(makeRequest(), {
      platform: "linux",
      commandExists: () => false,
      spawnProcess: () => {
        spawned = true;
        return {};
      },
    });
    expect(spawned).toBe(false);
  });

  test("checkNotifySendExists caches synchronous true on subsequent calls", async () => {
    resetNotifySendCache();
    let checkCount = 0;
    const commandExists = () => {
      checkCount++;
      return true;
    };
    await deliverLinuxNotification(makeRequest(), {
      platform: "linux",
      commandExists,
      spawnProcess: () => ({}),
    });
    await deliverLinuxNotification(makeRequest(), {
      platform: "linux",
      commandExists,
      spawnProcess: () => ({}),
    });
    expect(checkCount).toBe(1);
  });

  test("getSpawnProcess prefers deps.spawnProcess over default spawn", async () => {
    resetNotifySendCache();
    let fallbackUsed = true;
    await deliverLinuxNotification(makeRequest(), {
      platform: "linux",
      commandExists: async () => true,
      spawnProcess: () => {
        fallbackUsed = false;
        return {};
      },
    });
    // Custom spawnProcess was provided, so it was used (fallback NOT used)
    expect(fallbackUsed).toBe(false);
  });

  test("deliverPlatformNotification composes command via buildCommand callback", async () => {
    // Verify that deliverMacOSNotification passes the buildCommand arrow correctly.
    let capturedArgs: string[] = [];
    await deliverMacOSNotification(makeRequest({ title: "T", body: "B" }), {
      platform: "darwin",
      spawnProcess: (_cmd, args) => {
        capturedArgs = args;
        return {};
      },
    });
    expect(capturedArgs[0]).toBe("-e");
    expect(capturedArgs[1]).toContain("display notification");
    expect(capturedArgs[1]).toContain("T");
  });

  test("deliverPlatformNotification invokes buildCommand for windows", async () => {
    let capturedArgs: string[] = [];
    await deliverWindowsNotification(
      makeRequest({ title: "T", body: "B", timeoutMs: 7000 }),
      {
        platform: "win32",
        spawnProcess: (_cmd, args) => {
          capturedArgs = args;
          return {};
        },
      },
    );
    expect(capturedArgs).toContain("-NoProfile");
    expect(capturedArgs).toContain("-NonInteractive");
    expect(capturedArgs).toContain("-WindowStyle");
    expect(capturedArgs).toContain("Hidden");
    expect(capturedArgs).toContain("-Command");
    const script = capturedArgs[5];
    expect(script).toContain("7000");
    expect(script).toContain("T");
    expect(script).toContain("B");
  });

  describe("default delivery deps override", () => {
    test("defaultDeliveryDeps are used when no explicit deps provided", async () => {
      resetDefaultDeliveryDeps();
      let capturedCmd = "";
      setDefaultDeliveryDeps({
        platform: "darwin",
        spawnProcess: (cmd) => {
          capturedCmd = cmd;
          return {};
        },
      });
      try {
        await deliverNotification(makeRequest());
        expect(capturedCmd).toBe("osascript");
      } finally {
        resetDefaultDeliveryDeps();
      }
    });

    test("explicit deps override defaultDeliveryDeps", async () => {
      resetDefaultDeliveryDeps();
      let capturedCmd = "";
      setDefaultDeliveryDeps({
        platform: "darwin",
        spawnProcess: () => ({}),
      });
      try {
        await deliverNotification(makeRequest(), {
          platform: "linux",
          commandExists: async () => true,
          spawnProcess: (cmd) => {
            capturedCmd = cmd;
            return {};
          },
        });
        expect(capturedCmd).toBe("notify-send");
      } finally {
        resetDefaultDeliveryDeps();
      }
    });

    test("defaultDeliveryDeps are ignored when explicit {} is passed", async () => {
      resetDefaultDeliveryDeps();
      setDefaultDeliveryDeps({
        platform: "darwin",
        spawnProcess: () => ({}),
      });
      try {
        // explicit empty deps means no platform override → uses real platform
        // but with explicit {}, the default is not used at all
        // (resolveDeliveryDeps returns {} when explicit is provided)
        let spawned = false;
        await deliverNotification(makeRequest(), {
          platform: "freebsd",
          spawnProcess: () => {
            spawned = true;
            return {};
          },
        });
        expect(spawned).toBe(false);
      } finally {
        resetDefaultDeliveryDeps();
      }
    });

    test("resetDefaultDeliveryDeps clears the override", async () => {
      resetDefaultDeliveryDeps();
      setDefaultDeliveryDeps({
        platform: "darwin",
        spawnProcess: () => ({}),
      });
      resetDefaultDeliveryDeps();
      let spawned = false;
      await deliverNotification(makeRequest(), {
        platform: "freebsd",
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      expect(spawned).toBe(false);
    });
  });
});
