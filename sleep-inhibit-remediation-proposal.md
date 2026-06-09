# Remediation Proposal: Sleep Inhibitor Robustness on Linux (GNOME, KDE, and Wayland)

## 1. Findings

Analysis of [src/child/termination.ts](file:///home/lateef/Projects/pi-subagent/src/child/termination.ts) and [src/child/process.ts](file:///home/lateef/Projects/pi-subagent/src/child/process.ts) identified several limitations in the sleep inhibition logic for Linux:

*   **Desktop Environment Session Isolation**:
    *   Many Linux desktop environments (such as GNOME or KDE) manage power settings independently via session-level services (like `gsd-power` or `org.freedesktop.PowerManagement`).
    *   These environments bypass system-wide `systemd-logind` locks.
    *   `pi-subagent` only invokes `/usr/bin/systemd-inhibit`, which GNOME/KDE power settings can override or ignore.
*   **Wayland Session Compatibility**:
    *   Wayland restricts traditional X11 tools from querying idle state or inhibiting sleep.
    *   Modern sleep inhibition under Wayland requires interacting directly with desktop-specific D-Bus session APIs or desktop-specific command-line utilities.
    *   **Clarification**: `gnome-session-inhibit` and `kde-inhibit` communicate over D-Bus session APIs, not X11. They work correctly under Wayland compositors. No additional Wayland-specific handling is required beyond spawning these tools.
*   **Polkit Authorization and Privilege Restrictions**:
    *   Creating a `block` mode inhibitor for `sleep` or `idle` via `systemd-inhibit` often requires root privileges or interactive Polkit authorization (`org.freedesktop.login1.inhibit-block-sleep`).
    *   When running non-interactively or from an unprivileged shell without configured Polkit rules, the system denies or ignores the request.
    *   **Gap**: The proposed code spawns `systemd-inhibit --mode=block` unconditionally without addressing this privilege requirement. There is no fallback for unprivileged environments.
*   **Short-lived Wrapper Processes (PID Tracking Issue)**:
    *   The shell poll loop uses `kill -0 ${pid}` to detect when the agent exits.
    *   If `pid` is a short-lived wrapper process (a shell script or package manager launcher) that exits immediately after spawning the real worker, the poll loop exits prematurely, releasing all inhibitor locks.
    *   **Gap**: The proposed code fixes are in `termination.ts` only. The actual fix requires a call-site change in `process.ts` — passing `process.pid` (the orchestrator) to `acquire()` instead of the transient child PID. Without this, the poll loop watches the wrong PID regardless of how many inhibitors are spawned.
*   **`gnome-session-inhibit --inhibit` Flag Syntax Bug**:
    *   The `gnome-session-inhibit` CLI accepts a single `--inhibit` flag with a colon-separated list of inhibit types (e.g., `--inhibit=suspend:idle`).
    *   The proposed `makeGnomeInhibitArgs` passes two separate `--inhibit` flags (`--inhibit=suspend` and `--inhibit=idle`). Most implementations process only the last value, silently dropping `suspend` inhibition.

---

## 2. Recommendations

*   **Implement Session-Level Desktop Inhibitors**:
    *   Detect the active desktop environment via `process.env.XDG_CURRENT_DESKTOP`.
    *   Use `gnome-session-inhibit` on GNOME/Ubuntu and `kde-inhibit` on KDE Plasma to prevent desktop-managed sleep.
    *   These tools use D-Bus session APIs and work correctly under both X11 and Wayland — no separate Wayland path needed.
*   **Inhibit System and Session Levels Concurrently**:
    *   Spawn both desktop-specific and system-level (`systemd-inhibit`) helper processes concurrently when available.
    *   This dual-layer lock inhibits sleep at both layers.
*   **Fix `gnome-session-inhibit --inhibit` Syntax**:
    *   Pass a single `--inhibit=suspend:idle` flag (colon-separated) to correctly register both inhibit types.
*   **Fix PID Tracking at the Call Site**:
    *   In `process.ts`, pass `process.pid` (the orchestrator's PID) to `acquire()`, not the spawned child's PID.
    *   This ensures the inhibitor lock persists for the entire lifecycle of the orchestrating process and is immune to short-lived wrapper PIDs.
*   **Treat `systemd-inhibit` as Best-Effort**:
    *   Desktop-level inhibitors (`gnome-session-inhibit`, `kde-inhibit`) do not require elevated privileges and are the primary inhibition mechanism for unprivileged environments.
    *   `systemd-inhibit --mode=block` is spawned as a supplemental system-level lock. Its `error` event is suppressed; Polkit denial degrades silently to no-op.
*   **Graceful Degradation**:
    *   Handle spawn errors and command absence silently. Unprivileged execution must degrade gracefully to no-op without throwing exceptions.

---

## 3. Proposal Details

### A. Modified Inhibitor Command Generation
Update the inhibitor command builders in [src/child/termination.ts](file:///home/lateef/Projects/pi-subagent/src/child/termination.ts):

```typescript
function makeSystemdInhibitArgs(pid: number): string[] {
  return [
    "--what=sleep:idle",
    "--who=pi-subagent",
    "--why=subagent running",
    "--mode=block",
    SHELL_COMMAND,
    "-c",
    `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`,
  ];
}

function makeGnomeInhibitArgs(pid: number): string[] {
  return [
    "--app-id=pi-subagent",
    "--reason=subagent running",
    "--inhibit=suspend:idle",  // colon-separated; two separate --inhibit flags drop all but the last
    SHELL_COMMAND,
    "-c",
    `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`,
  ];
}

function makeKdeInhibitArgs(pid: number): string[] {
  return [
    "--power",
    "--screenSaver",
    SHELL_COMMAND,
    "-c",
    `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`,
  ];
}
```

### B. Composite Inhibitor Acquisition
Modify `makeHostSleepInhibitorAdapter` to query active desktop environments and spawn concurrent helper processes:

```typescript
function makeCompositeHelperHandle(
  helpers: SleepInhibitorHelperProcess[],
): SleepInhibitorAdapterHandle {
  for (const helper of helpers) {
    helper.on?.("error", () => undefined);
    helper.unref?.();
  }
  return {
    release() {
      for (const helper of helpers) {
        if (helperHasEnded(helper)) continue;
        helper.kill?.("SIGTERM");
      }
    },
  };
}

export function makeHostSleepInhibitorAdapter(
  options: HostSleepInhibitorAdapterOptions = {},
): SleepInhibitorAdapter {
  const platform = options.platform ?? process.platform;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const spawnHelper =
    options.spawnHelper ??
    ((command, args, spawnOptions) => spawn(command, args, spawnOptions));

  return {
    async supported() {
      if (platform === "win32") return true;
      if (platform === "darwin") return commandExists(CAFFEINATE_COMMAND);
      if (platform === "linux") {
        const [hasSystemd, hasGnome, hasKde] = await Promise.all([
          commandExists(SYSTEMD_INHIBIT_COMMAND),
          commandExists("gnome-session-inhibit"),
          commandExists("kde-inhibit"),
        ]);
        return hasSystemd || hasGnome || hasKde;
      }
      return false;
    },
    async acquire(pid) {
      if (platform === "darwin") {
        const helper = spawnHelper(CAFFEINATE_COMMAND, ["-dimsu", "-w", String(pid)], { stdio: "ignore", detached: true });
        return makeHelperHandle(helper);
      }
      if (platform === "win32") {
        const helper = spawnHelper(POWERSHELL_COMMAND, makePowerShellInhibitArgs(pid), { stdio: "ignore", detached: true });
        return makeHelperHandle(helper);
      }
      if (platform === "linux") {
        const helpers: SleepInhibitorHelperProcess[] = [];
        const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
        const isGnome = desktop.includes("gnome") || desktop.includes("ubuntu");
        const isKde = desktop.includes("kde");

        const [hasGnome, hasKde, hasSystemd] = await Promise.all([
          isGnome ? commandExists("gnome-session-inhibit") : Promise.resolve(false),
          isKde ? commandExists("kde-inhibit") : Promise.resolve(false),
          commandExists(SYSTEMD_INHIBIT_COMMAND),
        ]);

        if (hasGnome) {
          try {
            helpers.push(spawnHelper("gnome-session-inhibit", makeGnomeInhibitArgs(pid), { stdio: "ignore", detached: true }));
          } catch { /* spawn failure is non-fatal */ }
        }
        if (hasKde) {
          try {
            helpers.push(spawnHelper("kde-inhibit", makeKdeInhibitArgs(pid), { stdio: "ignore", detached: true }));
          } catch { /* spawn failure is non-fatal */ }
        }
        // Best-effort system-level lock; Polkit denial degrades silently via error suppression above.
        if (hasSystemd) {
          try {
            helpers.push(spawnHelper(SYSTEMD_INHIBIT_COMMAND, makeSystemdInhibitArgs(pid), { stdio: "ignore", detached: true }));
          } catch { /* spawn failure is non-fatal */ }
        }

        return makeCompositeHelperHandle(helpers);
      }
      return {};
    },
  };
}
```

### C. Call-Site Fix in `process.ts`
Pass `process.pid` (the orchestrator) to `acquire()` instead of the spawned child's PID. This is required for the poll loop in all inhibitor commands to watch the correct, long-lived process:

```typescript
// Before (tracks transient child PID — releases lock prematurely if child is a wrapper):
const handle = await adapter.acquire(child.pid);

// After (tracks orchestrator PID — lock held for full agent lifecycle):
const handle = await adapter.acquire(process.pid);
```
