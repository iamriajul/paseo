import { describe, expect, test } from "vitest";

import {
  buildGatewayAccountList,
  gatewayAccountAvailability,
  isServingAccount,
  summarizeGatewayAccounts,
} from "./accounts";
import type { GatewayQuotaAccount, GatewayQuotaPayload } from "./types";

function account(overrides: Partial<GatewayQuotaAccount> = {}): GatewayQuotaAccount {
  return { provider: "claude", type: "oauth", inCooldown: false, windows: [], ...overrides };
}

function payload(accounts: GatewayQuotaAccount[], supported = true): GatewayQuotaPayload {
  return { requestId: "quota-1", supported, fetchedAt: "2026-11-09T10:00:00.000Z", accounts };
}

const serving = { label: "u***b@example.com", provider: "Claude", inCooldown: false };

describe("gatewayAccountAvailability", () => {
  test("a cooling-down account is blocked until the reported end", () => {
    expect(
      gatewayAccountAvailability(
        account({ inCooldown: true, cooldownUntil: "2026-11-09T11:00:00Z" }),
      ),
    ).toEqual({ kind: "blocked", reason: "cooldown", until: "2026-11-09T11:00:00Z" });
  });

  test("a used-up account is blocked until its last used-up window resets", () => {
    expect(
      gatewayAccountAvailability(
        account({
          windows: [
            { name: "5h", usedPct: 100, resetsAt: "2026-11-09T12:00:00Z" },
            { name: "7d", usedPct: 100, resetsAt: "2026-11-12T00:00:00Z" },
            { name: "opus", usedPct: 40, resetsAt: "2026-11-15T00:00:00Z" },
          ],
        }),
      ),
    ).toEqual({ kind: "blocked", reason: "quota", until: "2026-11-12T00:00:00Z" });
  });

  test("an account under every limit is usable", () => {
    expect(gatewayAccountAvailability(account({ windows: [{ name: "5h", usedPct: 99 }] }))).toEqual(
      { kind: "usable" },
    );
  });
});

describe("isServingAccount", () => {
  test("matches on the masked label and the provider name", () => {
    expect(
      isServingAccount(account({ name: "u***b@example.com", providerName: "Claude" }), serving),
    ).toBe(true);
    expect(
      isServingAccount(account({ name: "u***a@example.com", providerName: "Claude" }), serving),
    ).toBe(false);
    expect(isServingAccount(account({ name: "u***b@example.com" }), serving)).toBe(false);
    expect(isServingAccount(account({ name: "u***b@example.com" }), null)).toBe(false);
  });
});

describe("buildGatewayAccountList", () => {
  test("is empty when the Gateway cannot report quota", () => {
    expect(buildGatewayAccountList(payload([account()], false), serving)).toEqual([]);
  });

  test("pins the serving account on top even when it is the busiest", () => {
    const list = buildGatewayAccountList(
      payload([
        account({ name: "idle", windows: [{ name: "5h", usedPct: 5 }] }),
        account({
          name: "u***b@example.com",
          providerName: "Claude",
          windows: [{ name: "5h", usedPct: 100, resetsAt: "2026-11-09T11:00:00Z" }],
        }),
      ]),
      serving,
    );
    expect(list.map((entry) => [entry.account.name, entry.serving])).toEqual([
      ["u***b@example.com", true],
      ["idle", false],
    ]);
    // Without a serving account (another model than the agent's), the usual order holds.
    expect(
      buildGatewayAccountList(payload(list.map((entry) => entry.account)), null).map(
        (entry) => entry.account.name,
      ),
    ).toEqual(["idle", "u***b@example.com"]);
  });

  test("puts usable accounts first by load, blocked ones last by reset, and marks the serving one", () => {
    const list = buildGatewayAccountList(
      payload([
        account({ name: "late", inCooldown: true, cooldownUntil: "2026-11-09T15:00:00Z" }),
        account({ name: "busy", windows: [{ name: "5h", usedPct: 80 }] }),
        account({ name: "unknown-reset", inCooldown: true }),
        account({
          name: "soon",
          windows: [{ name: "5h", usedPct: 100, resetsAt: "2026-11-09T11:00:00Z" }],
        }),
        account({
          name: "u***b@example.com",
          providerName: "Claude",
          windows: [{ name: "5h", usedPct: 10 }],
        }),
      ]),
      serving,
    );

    expect(list.map((entry) => entry.account.name)).toEqual([
      "u***b@example.com",
      "busy",
      "soon",
      "late",
      "unknown-reset",
    ]);
    expect(list.map((entry) => entry.serving)).toEqual([true, false, false, false, false]);
    expect(summarizeGatewayAccounts(list)).toEqual({ total: 5, usable: 2, blocked: 3 });
  });
});
