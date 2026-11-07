import { describe, expect, test, vi } from "vitest";

import {
  fetchGatewaySessionRoute,
  gatewayRoutedSessionId,
  gatewaySessionIdFor,
} from "./session-route.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const accountA = {
  provider: "claude",
  provider_name: "Claude",
  name: "u***a@example.com",
  type: "oauth",
  plan: "Max",
  in_cooldown: true,
};
const accountB = { ...accountA, name: "u***b@example.com", in_cooldown: false };

const record = {
  session: "claude:7f0c",
  account: accountB,
  model: "claude-haiku-5-5",
  since: "2026-11-06T11:00:05Z",
  last_seen: "2026-11-06T11:00:09Z",
  switches: [
    {
      at: "2026-11-06T11:00:05Z",
      from: accountA,
      to: accountB,
      reason: "quota",
      status_code: 429,
    },
  ],
};

describe("fetchGatewaySessionRoute", () => {
  const base = { baseUrl: "http://gateway:8317/", token: "sk-test", session: "claude:7f0c" };

  test("maps the serving account and its switches, and asks for the session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(record));

    const result = await fetchGatewaySessionRoute({ ...base, fetchImpl });

    expect(result).toEqual({
      supported: true,
      route: {
        account: { label: "u***b@example.com", provider: "Claude", plan: "Max", inCooldown: false },
        since: "2026-11-06T11:00:05Z",
        switches: [
          {
            at: "2026-11-06T11:00:05Z",
            from: {
              label: "u***a@example.com",
              provider: "Claude",
              plan: "Max",
              inCooldown: true,
            },
            to: { label: "u***b@example.com", provider: "Claude", plan: "Max", inCooldown: false },
            reason: "quota",
            statusCode: 429,
          },
        ],
      },
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://gateway:8317/v1/session-route?session=claude%3A7f0c",
    );
  });

  test("labels a removed account by its provider", async () => {
    const removed = { provider: "codex", provider_name: "Codex", in_cooldown: false };
    const fetchImpl = vi.fn(async () => jsonResponse({ ...record, account: removed }));

    const result = await fetchGatewaySessionRoute({ ...base, fetchImpl });

    expect(result.route?.account).toEqual({ label: "Codex", provider: "Codex", inCooldown: false });
  });

  test.each([
    ["an unknown session", jsonResponse({ error: "no request served for session" }, 404)],
    ["a Gateway without the route", new Response("", { status: 404 })],
    ["a bad key", jsonResponse({ error: "Invalid API key" }, 401)],
    ["an unparseable body", jsonResponse("not json")],
    ["a body missing the account", jsonResponse({ ...record, account: undefined })],
  ])("hides on %s", async (_label, response) => {
    const result = await fetchGatewaySessionRoute({ ...base, fetchImpl: async () => response });
    expect(result).toEqual({ supported: false, route: null });
  });

  test("hides on a transport failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await fetchGatewaySessionRoute({ ...base, fetchImpl });
    expect(result).toEqual({ supported: false, route: null });
  });
});

describe("gatewaySessionIdFor", () => {
  test("prefixes the harness family the Gateway keys sessions by", () => {
    expect(gatewaySessionIdFor("claude", " 7f0c ")).toBe("claude:7f0c");
    expect(gatewaySessionIdFor("codex", "019a")).toBe("codex:019a");
    expect(gatewaySessionIdFor("opencode", "ses_e4f5")).toBe("header:ses_e4f5");
  });

  test("has no session for a harness the Gateway cannot key, or no session yet", () => {
    expect(gatewaySessionIdFor("pi", "abc")).toBeNull();
    expect(gatewaySessionIdFor("claude", null)).toBeNull();
    expect(gatewaySessionIdFor("claude", "  ")).toBeNull();
  });
});

describe("gatewayRoutedSessionId", () => {
  test("a native fork looks up the root session it routes under", () => {
    expect(
      gatewayRoutedSessionId({
        config: { providerOptions: { sessionAffinityId: "root" } },
        persistence: { sessionId: "fork" },
      }),
    ).toBe("root");
  });

  test("any other agent looks up its own session", () => {
    expect(gatewayRoutedSessionId({ config: {}, persistence: { sessionId: "own" } })).toBe("own");
    expect(gatewayRoutedSessionId({ config: {}, persistence: null })).toBeNull();
  });
});
