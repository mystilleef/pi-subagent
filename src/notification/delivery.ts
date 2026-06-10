/**
 * Platform delivery implementations for desktop notifications.
 *
 * Delivers notification requests through safe native commands with
 * async bounded subprocess handling and silent degradation.
 */

import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import type { NotificationRequest } from "./desktop-notification.js";

const LINUX_NOTIFY_SEND = "notify-send";

export type DeliveryDependencies = {
  platform?: NodeJS.Platform;
  commandExists?: (command: string) => boolean | Promise<boolean>;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { stdio: "ignore" },
  ) => { unref?: () => void };
};

type SpawnProcess = NonNullable<DeliveryDependencies["spawnProcess"]>;

type NotificationCommand = {
  command: string;
  args: string[];
};

type BuildNotificationCommand = (
  request: NotificationRequest,
) => NotificationCommand;

type NotificationDelivery = (
  request: NotificationRequest,
  deps?: DeliveryDependencies,
) => Promise<void>;

export async function defaultCommandExists(command: string): Promise<boolean> {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  const entries = pathEnv.split(":").filter((e) => e.length > 0);
  for (const entry of entries) {
    const dir = entry.replace(/\/+$/, "");
    const candidate = join(dir, command);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, 1); // X_OK
      return true;
    } catch {}
  }
  return false;
}

let defaultDeliveryDeps: DeliveryDependencies | undefined;

export function setDefaultDeliveryDeps(
  deps: DeliveryDependencies | undefined,
): void {
  defaultDeliveryDeps = deps;
}

export function resetDefaultDeliveryDeps(): void {
  defaultDeliveryDeps = undefined;
}

let notifySendAvailable: boolean | undefined;

export function resetNotifySendCache(): void {
  notifySendAvailable = undefined;
}

async function checkNotifySendExists(
  commandExists: (command: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  if (notifySendAvailable !== undefined) return notifySendAvailable;
  try {
    notifySendAvailable = await commandExists(LINUX_NOTIFY_SEND);
  } catch {
    notifySendAvailable = false;
  }
  return notifySendAvailable;
}

function escapeLinuxArgs(request: NotificationRequest): string[] {
  const args: string[] = [];
  if (request.urgency === "critical") args.push("--urgency=critical");
  args.push(`--expire-time=${request.timeoutMs}`);
  args.push(request.title);
  args.push(request.body);
  return args;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildAppleScript(request: NotificationRequest): string {
  const title = escapeAppleScriptString(request.title);
  const body = escapeAppleScriptString(request.body);
  return `display notification "${body}" with title "${title}"`;
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildPowerShellScript(request: NotificationRequest): string {
  const title = escapePowerShellString(request.title);
  const body = escapePowerShellString(request.body);
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    `$notify = New-Object System.Windows.Forms.NotifyIcon`,
    `$notify.Icon = [System.Drawing.SystemIcons]::Information`,
    `$notify.Visible = $true`,
    `$notify.ShowBalloonTip(${request.timeoutMs}, '${title}', '${body}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    `Start-Sleep -Milliseconds ${request.timeoutMs + 500}`,
    `$notify.Dispose()`,
  ].join("; ");
}

function getSpawnProcess(deps: DeliveryDependencies): SpawnProcess {
  return deps.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, opts));
}

function shouldDeliverToPlatform(
  deps: DeliveryDependencies,
  platform: NodeJS.Platform,
): boolean {
  return (deps.platform ?? process.platform) === platform;
}

function runDetached(
  spawnFn: SpawnProcess,
  command: string,
  args: string[],
): void {
  try {
    const child = spawnFn(command, args, { stdio: "ignore" });
    child.unref?.();
  } catch {
    /* spawn failures degrade silently */
  }
}

async function deliverPlatformNotification(
  request: NotificationRequest,
  deps: DeliveryDependencies,
  platform: NodeJS.Platform,
  buildCommand: BuildNotificationCommand,
): Promise<void> {
  if (!shouldDeliverToPlatform(deps, platform)) return;
  const { command, args } = buildCommand(request);
  runDetached(getSpawnProcess(deps), command, args);
}

export async function deliverLinuxNotification(
  request: NotificationRequest,
  deps: DeliveryDependencies = {},
): Promise<void> {
  if (!shouldDeliverToPlatform(deps, "linux")) return;
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const available = await checkNotifySendExists(commandExists);
  if (!available) return;
  runDetached(
    getSpawnProcess(deps),
    LINUX_NOTIFY_SEND,
    escapeLinuxArgs(request),
  );
}

export async function deliverMacOSNotification(
  request: NotificationRequest,
  deps: DeliveryDependencies = {},
): Promise<void> {
  await deliverPlatformNotification(
    request,
    deps,
    "darwin",
    (notification) => ({
      command: "osascript",
      args: ["-e", buildAppleScript(notification)],
    }),
  );
}

export async function deliverWindowsNotification(
  request: NotificationRequest,
  deps: DeliveryDependencies = {},
): Promise<void> {
  await deliverPlatformNotification(request, deps, "win32", (notification) => ({
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      buildPowerShellScript(notification),
    ],
  }));
}

const PLATFORM_DELIVERIES: Partial<
  Record<NodeJS.Platform, NotificationDelivery>
> = {
  linux: deliverLinuxNotification,
  darwin: deliverMacOSNotification,
  win32: deliverWindowsNotification,
};

function resolveDeliveryDeps(
  explicit?: DeliveryDependencies,
): DeliveryDependencies {
  if (!defaultDeliveryDeps) return explicit ?? {};
  if (!explicit) return defaultDeliveryDeps;
  return { ...defaultDeliveryDeps, ...explicit };
}

export async function deliverNotification(
  request: NotificationRequest,
  deps?: DeliveryDependencies,
): Promise<void> {
  const resolved = resolveDeliveryDeps(deps);
  const platform = resolved.platform ?? process.platform;
  const deliver = PLATFORM_DELIVERIES[platform];
  if (deliver) await deliver(request, resolved);
}
