import { describe, expect, test } from "bun:test";
import type { SubagentTheme } from "../src/output/ui.js";
import {
  clearProgressState,
  createProgressState,
  renderSubagentProgress,
} from "../src/progress/progress.js";

const fakeTheme: SubagentTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

describe("progress.ts uncovered branches", () => {
  describe("renderSubagentProgress", () => {
    test("message without details returns undefined", () => {
      const result = renderSubagentProgress({}, { expanded: false }, fakeTheme);
      expect(result).toBeUndefined();
    });

    test("message with details but no requestId returns undefined", () => {
      const result = renderSubagentProgress(
        { details: {} },
        { expanded: false },
        fakeTheme,
      );
      expect(result).toBeUndefined();
    });

    test("message with requestId but no progress state returns undefined", () => {
      const result = renderSubagentProgress(
        { details: { requestId: "nonexistent-id" } },
        { expanded: false },
        fakeTheme,
      );
      expect(result).toBeUndefined();
    });

    test("message with valid requestId returns component", () => {
      const requestId = `test-render-${Date.now()}`;
      createProgressState(requestId, "test-agent", "user", "test task");
      const result = renderSubagentProgress(
        { details: { requestId } },
        { expanded: false },
        fakeTheme,
      );
      expect(result).toBeDefined();
      clearProgressState(requestId);
    });
  });
});
