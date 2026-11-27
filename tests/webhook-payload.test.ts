import { describe, expect, test } from "bun:test";
import {
  buildNotificationRequest,
  NOTIFICATION_TITLE,
  type NotificationRequest,
} from "../src/notification/desktop-notification.js";
import { buildWebhookPayload } from "../src/notification/webhook-payload.js";
import type { SubagentProgressState } from "../src/progress/progress-state.js";
import { setupFixtureHooks, withEnv } from "./fixtures.js";

setupFixtureHooks();

/** Fixed clock reading behind every request timestamp. */
const NOW = (): number => 6000;

const NOW_ISO = "1970-01-01T00:00:06.000Z";

function makeState(
  overrides: Partial<SubagentProgressState> = {},
): SubagentProgressState {
  return {
    requestId: "req-1",
    agent: "test-agent",
    taskPreview: "test task",
    status: "success",
    startTime: 1000,
    durationMs: 3000,
    toolCount: 1,
    ...overrides,
  };
}

describe("webhook-payload.ts", () => {
  describe("buildWebhookPayload", () => {
    test("returns no body for a desktop-only request without metadata", () => {
      const request: NotificationRequest = {
        title: NOTIFICATION_TITLE,
        body: "test-agent finished in 5.0s",
        urgency: "normal",
        timeoutMs: 5000,
      };

      expect(buildWebhookPayload(request)).toBeUndefined();
    });

    test.each([
      {
        status: "success",
        message: "test-agent finished in 3.0s",
        event: "subagent.completed",
        urgency: "normal",
      },
      {
        status: "running",
        message: "test-agent finished in 3.0s",
        event: "subagent.completed",
        urgency: "normal",
      },
      {
        status: "cancelled",
        message: "test-agent finished in 3.0s",
        event: "subagent.completed",
        urgency: "normal",
      },
      {
        status: "error",
        message: "test-agent failed after 3.0s",
        event: "subagent.failed",
        urgency: "critical",
      },
    ] as const)("projects the exact envelope for a $status request", (row) => {
      const request = buildNotificationRequest(
        makeState({ status: row.status, instanceName: "researcher" }),
        NOW,
      );

      expect(buildWebhookPayload(request)).toStrictEqual({
        event: row.event,
        title: "Pi Subagent",
        message: row.message,
        text: `Pi Subagent: ${row.message}`,
        content: `Pi Subagent: ${row.message}`,
        agent: "test-agent",
        status: row.status,
        durationMs: 3000,
        timestamp: NOW_ISO,
        instanceName: "researcher",
        urgency: row.urgency,
      });
    });

    test("omits the instance name when progress state has none", () => {
      const request = buildNotificationRequest(makeState(), NOW);

      expect(buildWebhookPayload(request)).toStrictEqual({
        event: "subagent.completed",
        title: "Pi Subagent",
        message: "test-agent finished in 3.0s",
        text: "Pi Subagent: test-agent finished in 3.0s",
        content: "Pi Subagent: test-agent finished in 3.0s",
        agent: "test-agent",
        status: "success",
        durationMs: 3000,
        timestamp: NOW_ISO,
        urgency: "normal",
      });
    });

    test("omits an empty instance name supplied by metadata", () => {
      const request: NotificationRequest = {
        title: NOTIFICATION_TITLE,
        body: "test-agent finished in 1.0s",
        urgency: "normal",
        timeoutMs: 5000,
        metadata: {
          agent: "test-agent",
          status: "success",
          instanceName: "",
          durationMs: 1000,
          timestamp: NOW_ISO,
        },
      };

      expect(buildWebhookPayload(request)).toStrictEqual({
        event: "subagent.completed",
        title: "Pi Subagent",
        message: "test-agent finished in 1.0s",
        text: "Pi Subagent: test-agent finished in 1.0s",
        content: "Pi Subagent: test-agent finished in 1.0s",
        agent: "test-agent",
        status: "success",
        durationMs: 1000,
        timestamp: NOW_ISO,
        urgency: "normal",
      });
    });

    test("takes human-readable copy from the request, not progress output", () => {
      const request: NotificationRequest = {
        title: "Deploy Reporter",
        body: "deploy-agent finished in 12.5s",
        urgency: "normal",
        timeoutMs: 5000,
        metadata: {
          agent: "deploy-agent",
          status: "success",
          durationMs: 12500,
          timestamp: NOW_ISO,
        },
      };

      expect(buildWebhookPayload(request)).toStrictEqual({
        event: "subagent.completed",
        title: "Deploy Reporter",
        message: "deploy-agent finished in 12.5s",
        text: "Deploy Reporter: deploy-agent finished in 12.5s",
        content: "Deploy Reporter: deploy-agent finished in 12.5s",
        agent: "deploy-agent",
        status: "success",
        durationMs: 12500,
        timestamp: NOW_ISO,
        urgency: "normal",
      });
    });

    test.each([
      {
        name: "critical request urgency with success metadata",
        urgency: "critical",
        status: "success",
        event: "subagent.completed",
        payloadUrgency: "normal",
      },
      {
        name: "normal request urgency with error metadata",
        urgency: "normal",
        status: "error",
        event: "subagent.failed",
        payloadUrgency: "critical",
      },
    ] as const)(
      "derives event and urgency from metadata status for $name",
      (row) => {
        const request: NotificationRequest = {
          title: NOTIFICATION_TITLE,
          body: "test-agent finished in 1.0s",
          urgency: row.urgency,
          timeoutMs: 5000,
          metadata: {
            agent: "test-agent",
            status: row.status,
            durationMs: 1000,
            timestamp: NOW_ISO,
          },
        };

        expect(buildWebhookPayload(request)).toMatchObject({
          event: row.event,
          urgency: row.payloadUrgency,
        });
      },
    );

    test("excludes execution content from the envelope with debug enabled", () => {
      withEnv({ PI_SUBAGENT_DEBUG_ENABLED: "1" }, () => {
        const request = buildNotificationRequest(
          makeState({
            status: "error",
            taskPreview: "PRIVATE_TASK_PREVIEW",
            lastToolPreview: "PRIVATE_TOOL_ARGUMENTS",
            finalOutput: "PRIVATE_FINAL_OUTPUT",
            errorText: "PRIVATE_ERROR_TEXT",
          }),
          NOW,
        );

        const payload = buildWebhookPayload(request);
        const serialized = JSON.stringify(payload);

        for (const secret of [
          "PRIVATE_TASK_PREVIEW",
          "PRIVATE_TOOL_ARGUMENTS",
          "PRIVATE_FINAL_OUTPUT",
          "PRIVATE_ERROR_TEXT",
        ]) {
          expect(serialized).not.toContain(secret);
        }

        expect(payload).toStrictEqual({
          event: "subagent.failed",
          title: "Pi Subagent",
          message: "test-agent failed after 3.0s",
          text: "Pi Subagent: test-agent failed after 3.0s",
          content: "Pi Subagent: test-agent failed after 3.0s",
          agent: "test-agent",
          status: "error",
          durationMs: 3000,
          timestamp: NOW_ISO,
          urgency: "critical",
        });
      });
    });
  });
});
