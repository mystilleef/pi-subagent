import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

    describe("PATH resolution via spawn", () => {
      let tempDir: string;
      let originalPath: string;
      beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-cmd-"));
        originalPath = process.env.PATH ?? "";
      });
      afterAll(() => {
        process.env.PATH = originalPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
      });
      test("resolves executable systemd-inhibit through command -v", async () => {
        const scriptPath = path.join(tempDir, "systemd-inhibit");
        fs.writeFileSync(scriptPath, "#!/bin/sh\necho ok\n");
        fs.chmodSync(scriptPath, 0o755);
        process.env.PATH = tempDir;
        const adapter = makeHostSleepInhibitorAdapter({
          platform: "linux",
        });
        const supported = await adapter.supported?.();
        expect(supported).toBe(true);
      });
      test("returns false for non-executable file in PATH", async () => {
        const scriptPath = path.join(tempDir, "systemd-inhibit");
        fs.writeFileSync(scriptPath, "#!/bin/sh\necho ok\n");
        fs.chmodSync(scriptPath, 0o644);
        process.env.PATH = tempDir;
        const adapter = makeHostSleepInhibitorAdapter({
          platform: "linux",
        });
        const supported = await adapter.supported?.();
        expect(supported).toBe(false);
      });
      test("returns false when PATH has no systemd-inhibit", async () => {
        const emptyDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "pi-test-empty-"),
        );
        try {
          process.env.PATH = emptyDir;
          const adapter = makeHostSleepInhibitorAdapter({
            platform: "linux",
          });
          const supported = await adapter.supported?.();
          expect(supported).toBe(false);
        } finally {
          fs.rmSync(emptyDir, { recursive: true, force: true });
        }
      });
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
      await handle.release();
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
      await handle.release();
    });

    test("adapter.supported returning false returns noop handle", async () => {
      const adapter = {
        supported: () => false,
        acquire: () => ({}),
      };
      const handle = await acquireChildSleepInhibitor(123, adapter);
      await handle.release();
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
      await handle.release();
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
      await handle.release();
    });

    test("non-finite pid returns noop handle", async () => {
      const adapter = {
        supported: () => true,
        acquire: () => ({}),
      };
      const handle = await acquireChildSleepInhibitor(NaN, adapter);
      await handle.release();
    });

    test("undefined pid returns noop handle", async () => {
      const adapter = {
        supported: () => true,
        acquire: () => ({}),
      };
      const handle = await acquireChildSleepInhibitor(undefined, adapter);
      await handle.release();
    });

    test("undefined adapter returns noop handle", async () => {
      const handle = await acquireChildSleepInhibitor(123, undefined);
      await handle.release();
    });
  });

  describe("makePidPollingShellArgs runtime", () => {
    const isLinux = os.platform() === "linux";
    const SHELL_COMMAND = "/bin/sh";
    function pidPollingArgs(pid: number): string[] {
      return [
        SHELL_COMMAND,
        "-c",
        `while kill -0 ${pid} 2>/dev/null && [ "$(cut -d' ' -f4 /proc/$$/stat 2>/dev/null)" != "1" ]; do sleep 1; done`,
      ];
    }
    describe("dead target", () => {
      test("exits immediately when target PID is dead", async () => {
        if (!isLinux) return;
        const shortLived = spawn("true");
        if (shortLived.pid === undefined)
          throw new Error("spawn true returned no PID");
        const deadPid = shortLived.pid;
        await new Promise<void>((resolve) =>
          shortLived.on("exit", () => resolve()),
        );
        const args = pidPollingArgs(deadPid);
        const command = args[0];
        if (!command) throw new Error("pidPollingArgs returned empty args");
        const polling = spawn(command, args.slice(1));
        const exitCode = await new Promise<number>((resolve) => {
          polling.on("exit", resolve);
        });
        expect(exitCode).toBe(0);
      }, 10_000);
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
          return command === "gnome-session-inhibit";
        },
      });
      const supported = await adapter.supported?.();
      expect(supported).toBe(true);
    });
  });
});
