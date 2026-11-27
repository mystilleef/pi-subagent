import { describe, expect, jest, spyOn, test } from "bun:test";
import {
  type DeliveryDependencies,
  resetDefaultDeliveryDeps,
  setDefaultDeliveryDeps,
  type WebhookFetch,
} from "../src/notification/delivery.js";
import {
  buildNotificationRequest,
  NOTIFICATION_TITLE,
  type NotificationRequest,
} from "../src/notification/desktop-notification.js";
import {
  deliverWebhookNotification,
  resolveWebhookUrl,
} from "../src/notification/webhook-delivery.js";
import type { SubagentProgressState } from "../src/progress/progress-state.js";
import { captureStdout, setupFixtureHooks, withEnv } from "./fixtures.js";

setupFixtureHooks(resetDefaultDeliveryDeps);

/** Fixed clock reading behind every request timestamp. */
const NOW = (): number => 6000;

const NOW_ISO = "1970-01-01T00:00:06.000Z";

const WEBHOOK_URL = "https://homeassistant.local:8123/api/webhook/test-hook";

/** Settings that resolve no receiver and therefore disable delivery. */
const DISABLED_RECEIVERS = [
  { name: "absent", value: undefined },
  { name: "empty", value: "" },
  { name: "whitespace-only", value: "   \t " },
  { name: "unparseable", value: "not a url" },
  { name: "non-HTTP(S)", value: "ftp://example.test/api/webhook/abc" },
  { name: "non-HTTP(S) file", value: "file:///etc/passwd" },
  { name: "non-HTTP(S) script", value: "javascript:alert(1)" },
  { name: "hostless", value: "http://" },
] as const;

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

function makeRequest(
  overrides: Partial<SubagentProgressState> = {},
): NotificationRequest {
  return buildNotificationRequest(makeState(overrides), NOW);
}

const DESKTOP_ONLY_REQUEST: NotificationRequest = {
  title: NOTIFICATION_TITLE,
  body: "test-agent finished in 3.0s",
  urgency: "normal",
  timeoutMs: 5000,
};

type FetchCall = { url: string; init: RequestInit };

function recordingFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
): { fetch: WebhookFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchFn: WebhookFetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return { fetch: fetchFn, calls };
}

/** Holds every request pending until its abort signal fires. */
function abortableFetch(): { fetch: typeof fetch; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  const fetchImpl = (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const signal = init?.signal;
    if (!signal) throw new Error("webhook delivery must pass an abort signal");
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  };
  return { fetch: Object.assign(fetchImpl, { preconnect: () => {} }), signals };
}

describe("resolveWebhookUrl", () => {
  test.each([
    {
      name: "an HTTP(S) URL with a port, path, and token",
      input: "https://homeassistant.local:8123/api/webhook/abc?token=xyz",
      expected: "https://homeassistant.local:8123/api/webhook/abc?token=xyz",
    },
    {
      name: "a plain HTTP URL with surrounding whitespace",
      input: "  http://192.168.1.10:8123/api/webhook/abc  ",
      expected: "http://192.168.1.10:8123/api/webhook/abc",
    },
    {
      name: "an upper-case scheme and host",
      input: "HTTPS://HomeAssistant.Local/api/webhook/abc",
      expected: "https://homeassistant.local/api/webhook/abc",
    },
  ])("resolves $name to its normalized href", ({ input, expected }) => {
    expect(resolveWebhookUrl({ PI_SUBAGENT_WEBHOOK_URL: input })).toBe(
      expected,
    );
  });

  test.each(DISABLED_RECEIVERS)(
    "disables delivery for a $name setting",
    ({ value }) => {
      const env: Partial<NodeJS.ProcessEnv> =
        value === undefined ? {} : { PI_SUBAGENT_WEBHOOK_URL: value };

      expect(resolveWebhookUrl(env)).toBeUndefined();
    },
  );

  test("reads the process environment when no env is supplied", () => {
    withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, () => {
      expect(resolveWebhookUrl()).toBe(WEBHOOK_URL);
    });
  });

  test("stays disabled when the process environment holds no receiver", () => {
    withEnv({ PI_SUBAGENT_WEBHOOK_URL: undefined }, () => {
      expect(resolveWebhookUrl()).toBeUndefined();
    });
  });

  test("ignores process.env when supplied an empty env object", () => {
    withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, () => {
      expect(resolveWebhookUrl({})).toBeUndefined();
    });
  });
});

describe("deliverWebhookNotification", () => {
  test("posts the serialized projection once to the resolved receiver", async () => {
    const { fetch, calls } = recordingFetch(
      async () => new Response(null, { status: 204 }),
    );

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, () =>
      deliverWebhookNotification(
        makeRequest({ status: "error", instanceName: "researcher" }),
        { fetch },
      ),
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one webhook POST");
    expect(call.url).toBe(WEBHOOK_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(call.init.redirect).toBe("manual");
    expect(JSON.parse(String(call.init.body))).toStrictEqual({
      event: "subagent.failed",
      title: "Pi Subagent",
      message: "test-agent failed after 3.0s",
      text: "Pi Subagent: test-agent failed after 3.0s",
      content: "Pi Subagent: test-agent failed after 3.0s",
      agent: "test-agent",
      status: "error",
      durationMs: 3000,
      timestamp: NOW_ISO,
      instanceName: "researcher",
      urgency: "critical",
    });
  });

  test.each(DISABLED_RECEIVERS)(
    "sends nothing for a $name receiver setting",
    async ({ value }) => {
      const { fetch, calls } = recordingFetch(
        async () => new Response(null, { status: 204 }),
      );

      await withEnv({ PI_SUBAGENT_WEBHOOK_URL: value }, () =>
        deliverWebhookNotification(makeRequest(), { fetch }),
      );

      expect(calls).toHaveLength(0);
    },
  );

  test("sends nothing for a request without a projection", async () => {
    const { fetch, calls } = recordingFetch(
      async () => new Response(null, { status: 204 }),
    );

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, () =>
      deliverWebhookNotification(DESKTOP_ONLY_REQUEST, { fetch }),
    );

    expect(calls).toHaveLength(0);
  });

  test("settles silently on a redirect response with no follow-up POST", async () => {
    const { fetch, calls } = recordingFetch(
      async () => new Response("moved", { status: 302 }),
    );

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, async () => {
      await expect(
        deliverWebhookNotification(makeRequest(), { fetch }),
      ).resolves.toBeUndefined();
    });

    expect(calls).toHaveLength(1);
  });

  test("settles silently on a non-2xx response", async () => {
    const { fetch } = recordingFetch(
      async () => new Response("unavailable", { status: 503 }),
    );

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, async () => {
      await expect(
        deliverWebhookNotification(makeRequest(), { fetch }),
      ).resolves.toBeUndefined();
    });
  });

  test("settles silently when fetch rejects", async () => {
    const fetchFn: WebhookFetch = async () => {
      throw new TypeError("network unreachable");
    };

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, async () => {
      await expect(
        deliverWebhookNotification(makeRequest(), { fetch: fetchFn }),
      ).resolves.toBeUndefined();
    });
  });

  test("settles silently and clears the timer when fetch throws synchronously", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchFn: WebhookFetch = (_url, init) => {
      if (init.signal) signals.push(init.signal);
      throw new Error("synchronous fetch failure");
    };

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, async () => {
      await expect(
        deliverWebhookNotification(makeRequest(), { fetch: fetchFn }),
      ).resolves.toBeUndefined();
    });

    expect(signals).toHaveLength(1);
    jest.advanceTimersByTime(5000);
    expect(signals[0]?.aborted).toBe(false);
  });

  test.each([
    { name: "the fixed timeout", override: undefined, timeoutMs: 5000 },
    { name: "an overridden timeout", override: 25, timeoutMs: 25 },
  ])("aborts the request through its signal after $name", async (row) => {
    jest.useFakeTimers();
    const { fetch, signals } = abortableFetch();
    const deps: DeliveryDependencies =
      row.override === undefined
        ? { fetch }
        : { fetch, webhookTimeoutMs: row.override };
    let settled = false;

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, async () => {
      const delivery = deliverWebhookNotification(makeRequest(), deps).then(
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      jest.advanceTimersByTime(row.timeoutMs - 1);
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      await delivery;
    });

    expect(settled).toBe(true);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("clears the abort timer once fetch settles", async () => {
    jest.useFakeTimers();
    const { fetch, calls } = recordingFetch(
      async () => new Response(null, { status: 204 }),
    );

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, () =>
      deliverWebhookNotification(makeRequest(), { fetch }),
    );

    const signal = calls[0]?.init.signal;
    if (!signal) throw new Error("expected an abort signal");
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(5000);
    expect(signal.aborted).toBe(false);
  });

  test("clears the abort timer before a pending body cancellation settles", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    let startCancellation = (): void => {};
    const cancellationStarted = new Promise<void>((resolve) => {
      startCancellation = resolve;
    });
    let finishCancellation = (): void => {};
    const fetchFn: WebhookFetch = (_url, init) => {
      if (init.signal) signals.push(init.signal);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              startCancellation();
              return new Promise<void>((resolve) => {
                finishCancellation = resolve;
              });
            },
          }),
        ),
      );
    };

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, async () => {
      let settled = false;
      const delivery = deliverWebhookNotification(makeRequest(), {
        fetch: fetchFn,
      }).then(() => {
        settled = true;
      });

      await cancellationStarted;
      jest.advanceTimersByTime(5000);
      expect(signals[0]?.aborted).toBe(false);
      expect(settled).toBe(false);

      finishCancellation();
      await delivery;
      expect(settled).toBe(true);
    });
  });

  test("cancels the response body without reading it", async () => {
    let cancelled = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled += 1;
        },
      }),
    );
    const textRead = spyOn(response, "text");
    const jsonRead = spyOn(response, "json");
    const { fetch } = recordingFetch(async () => response);

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, () =>
      deliverWebhookNotification(makeRequest(), { fetch }),
    );

    expect(cancelled).toBe(1);
    expect(textRead).not.toHaveBeenCalled();
    expect(jsonRead).not.toHaveBeenCalled();
  });

  test("settles silently when response body cancellation rejects", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error("body cancellation failed");
        },
      }),
    );
    const { fetch } = recordingFetch(async () => response);

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, async () => {
      await expect(
        deliverWebhookNotification(makeRequest(), { fetch }),
      ).resolves.toBeUndefined();
    });
  });

  test("leaves no output and no desktop notification", async () => {
    const desktopSpawns: string[] = [];
    const { fetch } = recordingFetch(
      async () => new Response("unavailable", { status: 500 }),
    );
    setDefaultDeliveryDeps({
      fetch,
      platform: "linux",
      commandExists: () => true,
      spawnProcess: (command) => {
        desktopSpawns.push(command);
        return {};
      },
    });
    const stderrChunks: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write);
    let stdoutChunks: string[] = [];

    try {
      await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, () =>
        captureStdout(false, async (writeCalls) => {
          await deliverWebhookNotification(makeRequest());
          stdoutChunks = [...writeCalls];
        }),
      );
    } finally {
      stderrSpy.mockRestore();
    }

    expect(stdoutChunks).toEqual([]);
    expect(stderrChunks).toEqual([]);
    expect(desktopSpawns).toEqual([]);
  });

  test("prefers explicit dependencies over shared overrides", async () => {
    const overridden = recordingFetch(
      async () => new Response(null, { status: 204 }),
    );
    setDefaultDeliveryDeps({ fetch: overridden.fetch, webhookTimeoutMs: 1 });
    const explicit = recordingFetch(
      async () => new Response(null, { status: 204 }),
    );

    await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, () =>
      deliverWebhookNotification(makeRequest(), { fetch: explicit.fetch }),
    );

    expect(overridden.calls).toHaveLength(0);
    expect(explicit.calls).toHaveLength(1);
  });

  test("restores the native fetch and fixed timeout after a reset", async () => {
    const overridden = recordingFetch(
      async () => new Response(null, { status: 204 }),
    );
    setDefaultDeliveryDeps({ fetch: overridden.fetch, webhookTimeoutMs: 1 });
    resetDefaultDeliveryDeps();
    jest.useFakeTimers();
    const native = abortableFetch();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      native.fetch,
    );
    let settled = false;

    try {
      await withEnv({ PI_SUBAGENT_WEBHOOK_URL: WEBHOOK_URL }, async () => {
        const delivery = deliverWebhookNotification(makeRequest()).then(() => {
          settled = true;
        });
        await Promise.resolve();
        jest.advanceTimersByTime(4999);
        expect(settled).toBe(false);
        jest.advanceTimersByTime(1);
        await delivery;
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(overridden.calls).toHaveLength(0);
    expect(settled).toBe(true);
  });
});
