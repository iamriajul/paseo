import { describe, expect, test } from "vitest";

import { buildGatewayQuotaSections, summarizeGatewayQuota } from "./sections";
import type { GatewayQuotaAccount, GatewayQuotaPayload } from "./types";

function account(overrides: Partial<GatewayQuotaAccount> = {}): GatewayQuotaAccount {
  return {
    provider: "xai",
    type: "oauth",
    inCooldown: false,
    windows: [],
    ...overrides,
  };
}

function payload(overrides: Partial<GatewayQuotaPayload> = {}): GatewayQuotaPayload {
  return {
    requestId: "quota-1",
    supported: true,
    fetchedAt: "2026-09-25T14:00:00.000Z",
    accounts: [],
    ...overrides,
  };
}

describe("buildGatewayQuotaSections", () => {
  test("returns no sections when unsupported or empty", () => {
    expect(buildGatewayQuotaSections(payload({ supported: false }))).toEqual([]);
    expect(buildGatewayQuotaSections(payload({ accounts: [] }))).toEqual([]);
  });

  test("maps accounts with stable keys", () => {
    const first = account({
      provider: "xai",
      name: "xai-a***b.json",
      plan: "Pro",
      windows: [{ name: "5h", usedPct: 51, resetsAt: "2026-09-25T15:00:00Z" }],
    });
    const second = account({ provider: "codex", inCooldown: true, windows: [{ name: "7d" }] });
    const sections = buildGatewayQuotaSections(payload({ accounts: [first, second] }));

    expect(sections.map((section) => section.key)).toEqual(["xai/xai-a***b.json", "codex/1"]);
    expect(sections[0]?.account).toBe(first);
    expect(sections[1]?.account).toBe(second);
  });

  test("sorts usable accounts by load and cooling-down accounts last", () => {
    const sections = buildGatewayQuotaSections(
      payload({
        accounts: [
          account({
            provider: "xai",
            name: "drained",
            windows: [{ name: "5h", usedPct: 90 }],
          }),
          account({ provider: "codex", windows: [{ name: "7d", usedPct: 5 }] }),
          account({
            provider: "codex",
            name: "cooling",
            inCooldown: true,
            windows: [{ name: "7d", usedPct: 1 }],
          }),
        ],
      }),
    );

    expect(sections.map((section) => section.key)).toEqual([
      "codex/1",
      "xai/drained",
      "codex/cooling",
    ]);
  });

  test("summarizes ready and cooling-down counts", () => {
    const sections = buildGatewayQuotaSections(
      payload({
        accounts: [account({ provider: "codex" }), account({ provider: "xai", inCooldown: true })],
      }),
    );

    expect(summarizeGatewayQuota(sections)).toEqual({ total: 2, ready: 1, coolingDown: 1 });
  });
});
