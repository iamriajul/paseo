import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type { AgentManagerEvent } from "../agent-manager.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { GatewaySessionRouteResult, GatewayRouteSwitch } from "./session-route.js";
import {
  attachGatewaySessionRouteWatcher,
  type GatewaySessionRouteWatcherDeps,
} from "./session-route-watcher.js";

const START = Date.parse("2026-11-06T11:00:00Z");
const a = { label: "A", provider: "Claude", inCooldown: true };
const b = { label: "B", provider: "Claude", inCooldown: false };

function switchAt(at: string, reason = "cooldown"): GatewayRouteSwitch {
  return { at, from: a, to: b, reason };
}

function harness(options: { provider?: string; routed?: boolean; sessionId?: string | null } = {}) {
  let listener: ((event: AgentManagerEvent) => void) | null = null;
  const appended: AgentTimelineItem[] = [];
  let switches: GatewayRouteSwitch[] = [];
  const fetchRoute = vi.fn(
    async (): Promise<GatewaySessionRouteResult> => ({
      supported: true,
      route: { account: b, since: "", switches },
    }),
  );
  const agentManager = {
    subscribe: (callback: (event: AgentManagerEvent) => void) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    getAgent: () => ({
      provider: options.provider ?? "claude",
      internal: false,
      config: {},
      persistence:
        options.sessionId === null
          ? null
          : { provider: "claude", sessionId: options.sessionId ?? "7f0c" },
    }),
    appendTimelineItem: async (_agentId: string, item: AgentTimelineItem) => {
      appended.push(item);
      return { seq: appended.length, epoch: "e" };
    },
  } as unknown as GatewaySessionRouteWatcherDeps["agentManager"];
  const detach = attachGatewaySessionRouteWatcher({
    logger: pino({ level: "silent" }),
    agentManager,
    gateway: () => ({ baseUrl: "http://gateway:8317", apiKey: "sk-test" }),
    isGatewayRouted: () => options.routed ?? true,
    fetchRoute,
    now: () => START,
    settleMs: 0,
  });
  async function finishTurn(type: "turn_completed" | "turn_failed" = "turn_completed") {
    listener?.({
      type: "agent_stream",
      agentId: "agent-1",
      event: { type, provider: "claude" } as never,
    });
    const calls = fetchRoute.mock.calls.length;
    await vi.waitFor(() => expect(fetchRoute.mock.calls.length).toBe(calls + 1), { timeout: 300 });
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    appended,
    fetchRoute,
    detach,
    finishTurn,
    setSwitches: (next: GatewayRouteSwitch[]) => {
      switches = next;
    },
  };
}

describe("attachGatewaySessionRouteWatcher", () => {
  test("announces a switch once, after the turn that saw it", async () => {
    const h = harness();
    h.setSwitches([switchAt("2026-11-06T11:00:05Z")]);

    await h.finishTurn();
    await h.finishTurn();

    expect(h.appended).toEqual([
      { type: "notification", level: "info", message: "Switched account: A → B (cooldown)" },
    ]);
    expect(h.fetchRoute).toHaveBeenCalledWith({
      baseUrl: "http://gateway:8317",
      token: "sk-test",
      session: "claude:7f0c",
    });
  });

  test("announces only the switches newer than the last announcement", async () => {
    const h = harness();
    h.setSwitches([switchAt("2026-11-06T11:00:05Z")]);
    await h.finishTurn();
    h.setSwitches([switchAt("2026-11-06T11:00:05Z"), switchAt("2026-11-06T11:02:00Z", "quota")]);

    await h.finishTurn("turn_failed");

    expect(h.appended.map((item) => item.type === "notification" && item.message)).toEqual([
      "Switched account: A → B (cooldown)",
      "Switched account: A → B (quota)",
    ]);
  });

  test("does not re-announce switches from before the daemon started", async () => {
    const h = harness();
    h.setSwitches([switchAt("2026-11-06T10:59:00Z")]);

    await h.finishTurn();

    expect(h.appended).toEqual([]);
  });

  test("leaves agents that are not Gateway-routed alone", async () => {
    const h = harness({ routed: false });
    h.setSwitches([switchAt("2026-11-06T11:00:05Z")]);
    h.fetchRoute.mockClear();

    await expect(h.finishTurn()).rejects.toThrow();

    expect(h.appended).toEqual([]);
  });

  test("stops listening when detached", async () => {
    const h = harness();
    h.setSwitches([switchAt("2026-11-06T11:00:05Z")]);
    h.detach();

    await expect(h.finishTurn()).rejects.toThrow();

    expect(h.appended).toEqual([]);
  });
});
