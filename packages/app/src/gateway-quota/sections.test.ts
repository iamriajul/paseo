import { describe, expect, test } from "vitest";

import { buildGatewayQuotaSections } from "./sections";
import type { GatewayQuotaPayload } from "./types";

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

  test("groups accounts with headings and window bars", () => {
    const sections = buildGatewayQuotaSections(
      payload({
        accounts: [
          {
            provider: "xai",
            name: "xai-a***b.json",
            type: "oauth",
            plan: "Pro",
            inCooldown: false,
            windows: [{ name: "5h", usedPct: 51, resetsAt: "2026-09-25T15:00:00Z" }],
          },
          {
            provider: "codex",
            type: "api",
            inCooldown: true,
            windows: [{ name: "7d" }],
          },
        ],
      }),
    );

    expect(sections).toEqual([
      {
        key: "xai/xai-a***b.json",
        heading: "xai · Pro · xai-a***b.json",
        inCooldown: false,
        windows: [
          {
            id: "xai/xai-a***b.json/5h/0",
            label: "5h",
            usedPct: 51,
            resetsAt: "2026-09-25T15:00:00Z",
          },
        ],
      },
      {
        key: "codex/1",
        heading: "codex",
        inCooldown: true,
        windows: [{ id: "codex/1/7d/0", label: "7d", usedPct: null, resetsAt: null }],
      },
    ]);
  });
});
