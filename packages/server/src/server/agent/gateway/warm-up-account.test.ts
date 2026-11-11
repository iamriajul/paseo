import { describe, expect, test, vi } from "vitest";

import type { GatewayQuotaAccount, GatewayQuotaResult } from "./quota.js";
import type { GatewayRouteAccount, GatewaySessionRouteResult } from "./session-route.js";
import {
  readWarmUpAccountBlock,
  WARM_UP_ACCOUNT_CHECK_MAX_AGE_MS,
  type ReadWarmUpAccountBlockInput,
} from "./warm-up-account.js";

const serving: GatewayRouteAccount = {
  label: "u***a@example.com",
  provider: "Claude",
  inCooldown: false,
};

function quotaAccount(overrides: Partial<GatewayQuotaAccount> = {}): GatewayQuotaAccount {
  return {
    provider: "claude",
    providerName: "Claude",
    name: "u***a@example.com",
    type: "oauth",
    inCooldown: false,
    windows: [
      { name: "5h", usedPct: 40, resetsAt: "2026-11-07T12:00:00Z" },
      { name: "7d", usedPct: 70, resetsAt: "2026-11-10T00:00:00Z" },
    ],
    ...overrides,
  };
}

/** The agent's last request; the route's account has served since before it. */
const LAST_REQUEST_AT_MS = Date.parse("2026-11-07T09:00:00Z");

function routeResult(
  account: GatewayRouteAccount | null,
  since = "2026-11-07T08:00:00Z",
): GatewaySessionRouteResult {
  return account
    ? { supported: true, route: { account, since, switches: [] } }
    : { supported: true, route: null };
}

function check(input: {
  route?: GatewaySessionRouteResult;
  quota?: GatewayQuotaResult;
  agent?: Partial<ReadWarmUpAccountBlockInput["agent"]>;
  routed?: boolean;
  lastRequestAtMs?: number | null;
}) {
  const readRoute = vi.fn(async () => input.route ?? routeResult(serving));
  const readQuota = vi.fn(
    async () => input.quota ?? { supported: true, accounts: [quotaAccount()] },
  );
  const result = readWarmUpAccountBlock({
    agent: {
      provider: "claude",
      config: { model: "claude-haiku-5-5" },
      persistence: { sessionId: "7f0c" },
      ...input.agent,
    },
    gateway: { baseUrl: "http://gateway:8317", apiKey: "sk-test" },
    isGatewayRouted: () => input.routed ?? true,
    lastRequestAtMs:
      input.lastRequestAtMs === undefined ? LAST_REQUEST_AT_MS : input.lastRequestAtMs,
    readRoute,
    readQuota,
  });
  return { result, readRoute, readQuota };
}

describe("readWarmUpAccountBlock", () => {
  test("reads the agent's session route and its model's quota, freshly", async () => {
    const { result, readRoute, readQuota } = check({});
    expect(await result).toBeNull();
    expect(readRoute).toHaveBeenCalledWith({
      baseUrl: "http://gateway:8317",
      token: "sk-test",
      session: "claude:7f0c",
      maxAgeMs: WARM_UP_ACCOUNT_CHECK_MAX_AGE_MS,
    });
    expect(readQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-5-5",
        maxAgeMs: WARM_UP_ACCOUNT_CHECK_MAX_AGE_MS,
      }),
    );
  });

  test("blocks while the serving account cools down, until the Gateway's cooldown end", async () => {
    const { result } = check({
      route: routeResult({ ...serving, inCooldown: true, cooldownUntil: "2026-11-07T09:43:00Z" }),
    });
    expect(await result).toEqual({
      reason: "cooldown",
      account: "u***a@example.com",
      until: "2026-11-07T09:43:00Z",
    });
  });

  test("blocks at a used-up window until every used-up window has reset", async () => {
    const { result } = check({
      quota: {
        supported: true,
        accounts: [
          quotaAccount({
            windows: [
              { name: "5h", usedPct: 100, resetsAt: "2026-11-07T12:00:00Z" },
              { name: "7d", usedPct: 100, resetsAt: "2026-11-10T00:00:00Z" },
            ],
          }),
        ],
      },
    });
    expect(await result).toEqual({
      reason: "quota",
      account: "u***a@example.com",
      window: "5h",
      until: "2026-11-10T00:00:00Z",
    });
  });

  test("reads a quota account's own cooldown when the route has none", async () => {
    const { result } = check({
      quota: {
        supported: true,
        accounts: [quotaAccount({ inCooldown: true, cooldownUntil: "2026-11-07T10:00:00Z" })],
      },
    });
    expect(await result).toMatchObject({ reason: "cooldown", until: "2026-11-07T10:00:00Z" });
  });

  test("does not block on another account's used-up window", async () => {
    const { result } = check({
      quota: {
        supported: true,
        accounts: [
          quotaAccount(),
          quotaAccount({ name: "u***b@example.com", windows: [{ name: "5h", usedPct: 100 }] }),
        ],
      },
    });
    expect(await result).toBeNull();
  });

  test("blocks a shared masked label only when every account behind it is used up", async () => {
    const full = { windows: [{ name: "5h", usedPct: 100 }] };
    const mixed = check({
      quota: { supported: true, accounts: [quotaAccount(full), quotaAccount()] },
    });
    expect(await mixed.result).toBeNull();
    const both = check({
      quota: { supported: true, accounts: [quotaAccount(full), quotaAccount(full)] },
    });
    expect(await both.result).toMatchObject({ reason: "quota", window: "5h" });
  });

  test("a native fork checks the root session it routes under", async () => {
    const { result, readRoute } = check({
      agent: {
        config: { model: "claude-haiku-5-5", providerOptions: { sessionAffinityId: "root" } },
        persistence: { sessionId: "fork" },
      },
    });
    await result;
    expect(readRoute).toHaveBeenCalledWith(expect.objectContaining({ session: "claude:root" }));
  });

  test("reports no block for an agent the Gateway does not route, which it cannot check", async () => {
    const { result, readRoute } = check({ routed: false });
    expect(await result).toBeNull();
    expect(readRoute).not.toHaveBeenCalled();
  });

  test("blocks when the serving account is missing from the model's quota list", async () => {
    const { result } = check({
      quota: { supported: true, accounts: [quotaAccount({ name: "u***b@example.com" })] },
    });
    expect(await result).toEqual({ reason: "unlisted", account: "u***a@example.com" });
  });

  test("blocks when no account serves the model any more", async () => {
    const { result } = check({ quota: { supported: true, accounts: [] } });
    expect(await result).toEqual({ reason: "unlisted", account: "u***a@example.com" });
  });

  test("blocks when the route moved to another account after the agent's last request", async () => {
    const moved = { ...serving, label: "n***u@example.com" };
    const { result } = check({
      route: routeResult(moved, "2026-11-07T09:02:00Z"),
      quota: { supported: true, accounts: [quotaAccount({ name: "n***u@example.com" })] },
    });
    expect(await result).toEqual({ reason: "moved", account: "n***u@example.com" });
  });

  test("does not call it a move when the agent's own last request switched the account", async () => {
    // The Gateway stamps the request's start, a moment before the daemon's message_start.
    const { result } = check({ route: routeResult(serving, "2026-11-07T08:59:58Z") });
    expect(await result).toBeNull();
  });

  test("blocks when the Gateway no longer tracks the session", async () => {
    const { result } = check({ route: routeResult(null) });
    expect(await result).toEqual({ reason: "untracked", account: "" });
  });

  test("blocks when the Gateway has no session route at all", async () => {
    const { result } = check({ route: { supported: false, route: null } });
    expect(await result).toEqual({ reason: "unsupported", account: "" });
  });

  test.each([
    ["the session route read failed", { route: { supported: false, route: null, failed: true } }],
    ["the quota read failed", { quota: { supported: true, accounts: [], failed: true } }],
    ["the agent has no session to look up", { agent: { persistence: null } }],
  ] as const)("blocks as unconfirmed when %s", async (_label, input) => {
    const { result } = check(input as Parameters<typeof check>[0]);
    expect(await result).toEqual({ reason: "unconfirmed", account: "" });
  });

  test("checks the route's account and cooldown when the Gateway has no quota route", async () => {
    const { result } = check({ quota: { supported: false, accounts: [] } });
    expect(await result).toBeNull();
  });

  test("still blocks on the route's cooldown when the quota route is missing", async () => {
    const { result } = check({
      route: routeResult({ ...serving, inCooldown: true }),
      quota: { supported: false, accounts: [] },
    });
    expect(await result).toEqual({ reason: "cooldown", account: "u***a@example.com" });
  });
});
