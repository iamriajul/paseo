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

function routeResult(account: GatewayRouteAccount | null): GatewaySessionRouteResult {
  return account
    ? { supported: true, route: { account, since: "2026-11-07T08:00:00Z", switches: [] } }
    : { supported: false, route: null };
}

function check(input: {
  route?: GatewaySessionRouteResult;
  quota?: GatewayQuotaResult;
  agent?: Partial<ReadWarmUpAccountBlockInput["agent"]>;
  routed?: boolean;
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

  test.each([
    ["the agent is not Gateway-routed", { routed: false }],
    ["the agent has no session yet", { agent: { persistence: null } }],
    ["the Gateway has no session route", { route: routeResult(null) }],
  ])("reports no block when %s", async (_label, input) => {
    const { result } = check(input);
    expect(await result).toBeNull();
  });

  test("reports no block when the Gateway has no quota route and the account is not cooling", async () => {
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
