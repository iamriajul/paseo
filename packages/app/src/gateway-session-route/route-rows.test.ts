import { describe, expect, it } from "vitest";
import { buildSessionRouteRows } from "./route-rows";
import { pickGatewaySessionRoute } from "./use-gateway-session-route";

const a = { label: "u***a@example.com", provider: "Claude", plan: "Max", inCooldown: true };
const b = { label: "u***b@example.com", provider: "Claude", plan: "Max", inCooldown: false };

describe("buildSessionRouteRows", () => {
  it("shows the serving account with its plan", () => {
    expect(buildSessionRouteRows({ account: b, since: "", switches: [] })).toEqual([
      { label: "Served by", value: "u***b@example.com · Max" },
    ]);
  });

  it("says when the serving account is cooling down", () => {
    const rows = buildSessionRouteRows({ account: a, since: "", switches: [] });
    expect(rows[0]?.value).toBe("u***a@example.com · Max (cooling down)");
  });

  it("adds the newest switch and its cause", () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    const rows = buildSessionRouteRows({
      account: b,
      since: at,
      switches: [
        { at: "2026-01-01T00:00:00Z", from: b, to: a, reason: "rebind" },
        { at, from: a, to: b, reason: "quota", statusCode: 429 },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ label: "Switched", value: "5m ago (quota)" });
  });
});

describe("pickGatewaySessionRoute", () => {
  it("hides an unsupported answer", () => {
    expect(pickGatewaySessionRoute(undefined)).toBeNull();
    expect(pickGatewaySessionRoute({ requestId: "r", supported: false, route: null })).toBeNull();
  });
});
