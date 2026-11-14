import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Widths the handler passes to renderRunsBoard, in call order. The mock must
 * be registered before jobs-command is imported, so all production modules are
 * loaded dynamically in the beforeEach hook after registration. The real
 * runs-board exports are captured at load time and restored in afterAll as a
 * plain object, keeping the shared-process replacement scoped to this file.
 */
const realRunsBoard = await import("../src/output/runs-board.ts");
const realBoardExports = {
  ...realRunsBoard,
  renderRunsBoard: realRunsBoard.renderRunsBoard,
};

const boardWidths: number[] = [];

mock.module("../src/output/runs-board.ts", () => ({
  ...realRunsBoard,
  renderRunsBoard: (_states: unknown, _theme: unknown, width: number) => {
    boardWidths.push(width);
    return {
      render: (renderWidth: number) => [`mock-line-${renderWidth}`],
    };
  },
}));

afterAll(() => {
  mock.module("../src/output/runs-board.ts", () => realBoardExports);
});

type JobsCommandModule = typeof import("../src/orchestration/jobs-command.js");
type RunRegistryModule = typeof import("../src/orchestration/run-registry.js");
type ProgressStateModule = typeof import("../src/progress/progress-state.js");

let jobsCommandHandler: JobsCommandModule["jobsCommandHandler"];
let registerRunJob: RunRegistryModule["registerRunJob"];
let resetRunRegistry: RunRegistryModule["resetRunRegistry"];
let createProgressState: ProgressStateModule["createProgressState"];
let resetProgressStore: ProgressStateModule["resetProgressStore"];

const JOB_ID = "width-job";
const JOB_AGENT = "width-agent";
const JOB_INSTANCE = "width-inst";

beforeEach(async () => {
  ({ jobsCommandHandler } = await import(
    "../src/orchestration/jobs-command.js"
  ));
  ({ registerRunJob, resetRunRegistry } = await import(
    "../src/orchestration/run-registry.js"
  ));
  ({ createProgressState, resetProgressStore } = await import(
    "../src/progress/progress-state.js"
  ));
  resetRunRegistry();
  resetProgressStore();
  boardWidths.length = 0;
  createProgressState(JOB_ID, JOB_AGENT, "task", JOB_INSTANCE);
  registerRunJob({
    requestId: JOB_ID,
    agentName: JOB_AGENT,
    instanceName: JOB_INSTANCE,
    controller: new AbortController(),
    startedAt: Date.now(),
  });
});

type BoardComponent = {
  invalidate: () => void;
  render: (width: number) => string[];
};

/**
 * Fake command context that renders the board at the given width and captures
 * the component the handler registers so its lifecycle hooks stay assertable.
 */
function makeCapturingContext(renderWidth: number) {
  const notices: string[] = [];
  let captured: BoardComponent | undefined;
  const theme = {
    fg: (_color: unknown, text: string): string => text,
    bg: (_color: unknown, text: string): string => text,
    bold: (text: string): string => text,
    italic: (text: string): string => text,
    underline: (text: string): string => text,
    strikethrough: (text: string): string => text,
  };
  const ctx = {
    cwd: "/tmp",
    ui: {
      notify: (msg: string): void => {
        notices.push(msg);
      },
      custom: async (
        factory: (
          tui: unknown,
          factoryTheme: unknown,
          keybindings: unknown,
          done: (value: string) => void,
        ) => BoardComponent,
      ): Promise<string> => {
        let result = "";
        captured = await factory(undefined, theme, undefined, (value) => {
          result = value;
        });
        captured.invalidate();
        captured.render(renderWidth);
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    notices,
    component: (): BoardComponent => {
      if (!captured) {
        throw new Error("fake ui.custom never captured a component");
      }
      return captured;
    },
  };
}

test.each([
  {
    name: "/jobs clamps notify board width to 1 at board width 0",
    width: 0,
    notifyWidth: 1,
  },
  {
    name: "/jobs clamps notify board width to 1 at board width 1",
    width: 1,
    notifyWidth: 1,
  },
  {
    name: "/jobs clamps notify board width to 1 at board width 2",
    width: 2,
    notifyWidth: 1,
  },
  {
    name: "/jobs renders notify board at width 1 at board width 3",
    width: 3,
    notifyWidth: 1,
  },
  {
    name: "/jobs renders notify board two columns narrower at board width 4",
    width: 4,
    notifyWidth: 2,
  },
])("$name", async (row) => {
  const { ctx, notices } = makeCapturingContext(row.width);
  await jobsCommandHandler(ctx, "");
  expect(notices).toEqual([`mock-line-${row.notifyWidth}`]);
  expect(boardWidths).toEqual([row.width, row.notifyWidth]);
});

test("/jobs component keeps rendering after invalidate is invoked", async () => {
  const { ctx, notices, component } = makeCapturingContext(80);
  await jobsCommandHandler(ctx, "");
  expect(notices).toEqual(["mock-line-78"]);

  const before = component().render(80);
  component().invalidate();
  const after = component().render(80);
  expect(after).toEqual(before);
  expect(boardWidths).toEqual([80, 78, 80, 78, 80, 78]);
});
