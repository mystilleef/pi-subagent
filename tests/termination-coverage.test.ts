import { describe, expect, test } from "bun:test";
import {
  acquireChildSleepInhibitor,
  makeHostSleepInhibitorAdapter,
  type SleepInhibitorHelperProcess,
} from "../src/child/termination.js";

describe("termination.ts coverage gaps", () => {
  describe("defaultCommandExists", () => {
    test("returns false for non-existent command", async () => {
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "darwin",
      });
      const supported = await adapter.supported?.();
      expect(supported).toBe(false);
    });

    test("returns false for non-executable path", async () => {
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "linux",
        commandExists: () => false,
      });
      const supported = await adapter.supported?.();
      expect(supported).toBe(false);
    });
  });

  describe("helperHasEnded with signalCode", () => {
    test("helper with signalCode set is considered ended", async () => {
      let killCalled = false;
      const helper: SleepInhibitorHelperProcess = {
        exitCode: null,
        signalCode: "SIGTERM",
        kill: () => {
          killCalled = true;
        },
        on: () => {},
        unref: () => {},
      };
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "darwin",
        commandExists: () => true,
        spawnHelper: () => helper,
      });
      const handle = await acquireChildSleepInhibitor(123, adapter);
      await handle.release();
      expect(killCalled).toBe(false);
    });

    test("helper with both exitCode and signalCode null is not ended", async () => {
      let killCalled = false;
      const helper: SleepInhibitorHelperProcess = {
        exitCode: null,
        signalCode: null,
        kill: () => {
          killCalled = true;
        },
        on: () => {},
        unref: () => {},
      };
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "darwin",
        commandExists: () => true,
        spawnHelper: () => helper,
      });
      const handle = await acquireChildSleepInhibitor(123, adapter);
      await handle.release();
      expect(killCalled).toBe(true);
    });
  });

  describe("makeSleepInhibitorHandle release error handling", () => {
    test("acquireChildSleepInhibitor wraps helper handle with error handling", async () => {
      const helper: SleepInhibitorHelperProcess = {
        exitCode: null,
        signalCode: null,
        kill: () => {
          throw new Error("kill failed");
        },
        on: () => {},
        unref: () => {},
      };
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "darwin",
        commandExists: () => true,
        spawnHelper: () => helper,
      });
      const handle = await acquireChildSleepInhibitor(123, adapter);
      await expect(handle.release()).resolves.toBeUndefined();
    });
  });

  describe("acquireChildSleepInhibitor error paths", () => {
    test("acquisition failure returns noop handle", async () => {
      const adapter = {
        supported: () => true,
        acquire: () => {
          throw new Error("acquisition failed");
        },
      };
      const handle = await acquireChildSleepInhibitor(123, adapter);
      await expect(handle.release()).resolves.toBeUndefined();
    });

    test("adapter.supported returning false returns noop handle", async () => {
      const adapter = {
        supported: () => false,
        acquire: () => ({}),
      };
      const handle = await acquireChildSleepInhibitor(123, adapter);
      await expect(handle.release()).resolves.toBeUndefined();
    });

    test("adapter.acquire returning non-object returns noop handle", async () => {
      const adapter = {
        supported: () => true,
        acquire: () => "not an object",
      };
      const handle = await acquireChildSleepInhibitor(
        123,
        adapter as unknown as Parameters<typeof acquireChildSleepInhibitor>[1],
      );
      await expect(handle.release()).resolves.toBeUndefined();
    });

    test("adapter.acquire returning null returns noop handle", async () => {
      const adapter = {
        supported: () => true,
        acquire: () => null,
      };
      const handle = await acquireChildSleepInhibitor(
        123,
        adapter as unknown as Parameters<typeof acquireChildSleepInhibitor>[1],
      );
      await expect(handle.release()).resolves.toBeUndefined();
    });

    test("non-finite pid returns noop handle", async () => {
      const adapter = {
        supported: () => true,
        acquire: () => ({}),
      };
      const handle = await acquireChildSleepInhibitor(NaN, adapter);
      await expect(handle.release()).resolves.toBeUndefined();
    });

    test("undefined pid returns noop handle", async () => {
      const adapter = {
        supported: () => true,
        acquire: () => ({}),
      };
      const handle = await acquireChildSleepInhibitor(undefined, adapter);
      await expect(handle.release()).resolves.toBeUndefined();
    });

    test("undefined adapter returns noop handle", async () => {
      const handle = await acquireChildSleepInhibitor(123, undefined);
      await expect(handle.release()).resolves.toBeUndefined();
    });
  });

  describe("makeHostSleepInhibitorAdapter platform handling", () => {
    test("unsupported platform returns empty handle", async () => {
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "freebsd" as unknown as NodeJS.Platform,
      });
      const supported = await adapter.supported?.();
      expect(supported).toBe(false);
      const handle = adapter.acquire(123);
      expect(handle).toBeDefined();
    });

    test("win32 platform supported returns true", async () => {
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "win32",
      });
      const supported = await adapter.supported?.();
      expect(supported).toBe(true);
    });

    test("darwin platform with caffeinate returns true", async () => {
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "darwin",
        commandExists: () => true,
      });
      const supported = await adapter.supported?.();
      expect(supported).toBe(true);
    });

    test("linux platform with systemd-inhibit returns true", async () => {
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "linux",
        commandExists: () => true,
      });
      const supported = await adapter.supported?.();
      expect(supported).toBe(true);
    });

    test("linux desktop detection handles mixed delimiters deterministically", async () => {
      const adapter = makeHostSleepInhibitorAdapter({
        platform: "linux",
        environment: { XDG_CURRENT_DESKTOP: "Unity:ubuntu GNOME" },
        commandExists(command) {
          return command === "/usr/bin/gnome-session-inhibit";
        },
      });
      const supported = await adapter.supported?.();
      expect(supported).toBe(true);
    });
  });
});
