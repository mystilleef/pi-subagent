import { jest, mock, setSystemTime } from "bun:test";

/**
 * Restores spies, mock calls, timers, and system time. The preload runs it
 * after every case; fixture teardown runs it first because file hooks precede
 * preload hooks, and reaping children and temp trees needs real clocks and
 * unspied I/O. Imports no `src` module so the preload stays source-free.
 */
export function restoreTestGlobals(): void {
  mock.restore();
  mock.clearAllMocks();
  jest.useRealTimers();
  setSystemTime();
}
