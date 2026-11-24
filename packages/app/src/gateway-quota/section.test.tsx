// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GatewayAccountSection } from "./section";
import type { GatewayQuotaAccount, GatewayQuotaView } from "./types";

vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({
            spacing: new Proxy({}, { get: () => 4 }),
            fontSize: new Proxy({}, { get: () => 12 }),
            fontWeight: new Proxy({}, { get: () => "500" }),
            borderRadius: new Proxy({}, { get: () => 4 }),
            colors: new Proxy({}, { get: () => "#888" }),
          })
        : factory,
  },
}));

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("button", { type: "button" }, children),
  };
});

vi.mock("./account-row", async () => {
  const ReactModule = await import("react");
  return {
    GatewayQuotaAccountRow: (props: { account: GatewayQuotaAccount }) =>
      ReactModule.createElement("div", { "data-testid": "serving-row" }, props.account.name),
  };
});

function account(label: string): GatewayQuotaAccount {
  return {
    provider: "codex",
    providerName: "Codex",
    name: label,
    type: "oauth",
    inCooldown: false,
    windows: [],
  };
}

const quota: GatewayQuotaView = {
  kind: "ready",
  payload: {
    requestId: "q",
    supported: true,
    fetchedAt: "2026-11-24T01:00:00.000Z",
    accounts: [account("k***i@gmail.com"), account("n***u@gmail.com")],
  },
};

const LAST_SERVED = { at: "2026-11-23T23:12:17.073Z", account: "n***u@gmail.com", plan: "Plus" };
const LIVE_ROUTE = {
  account: { label: "k***i@gmail.com", provider: "Codex", inCooldown: false },
  since: "2026-11-24T01:00:00.000Z",
  switches: [],
};

describe("GatewayAccountSection", () => {
  afterEach(cleanup);

  it("names the account the agent last used when the Gateway has no live route for the session", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T01:40:00.000Z"));
    try {
      const { container, queryByTestId } = render(
        <GatewayAccountSection
          view={quota}
          route={null}
          lastServed={LAST_SERVED}
          serverId="server-1"
        />,
      );
      const text = container.textContent ?? "";
      expect(text).toContain("Last served by");
      expect(text).toContain("n***u@gmail.com · Plus");
      expect(text).toContain("Since2h ago");
      // A recorded account is history, not the live binding: no serving badge or row.
      expect(queryByTestId("serving-row")).toBeNull();
      expect(text).toContain("2 accounts can serve this model");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the live route over the recorded account", () => {
    const { container } = render(
      <GatewayAccountSection
        view={quota}
        route={LIVE_ROUTE}
        lastServed={LAST_SERVED}
        serverId="server-1"
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("k***i@gmail.com");
    expect(text).not.toContain("Last served by");
  });
});
