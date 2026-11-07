import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import type {
  GatewayAccountChange,
  PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";
import type { AgentManagerEvent } from "../agent-manager.js";
import type {
  GatewayRouteAccount,
  GatewayRouteSwitch,
  GatewaySessionRoute,
  GatewaySessionRouteResult,
} from "./session-route.js";
import {
  attachGatewaySessionRouteWatcher,
  nextGatewayAccountChanges,
  type GatewaySessionRouteWatcherDeps,
} from "./session-route-watcher.js";

const a: GatewayRouteAccount = { label: "A", provider: "Claude", inCooldown: true };
const b: GatewayRouteAccount = { label: "B", provider: "Claude", plan: "Max", inCooldown: false };

function switchAt(at: string, reason = "quota", statusCode?: number): GatewayRouteSwitch {
  return { at, from: a, to: b, reason, ...(statusCode ? { statusCode } : {}) };
}

function route(account: GatewayRouteAccount, since: string, switches: GatewayRouteSwitch[] = []) {
  return { account, since, switches } satisfies GatewaySessionRoute;
}

function request(at: string, hit: boolean): PromptCacheHistoryEntry {
  return {
    at,
    kind: "request",
    readTokens: hit ? 50_000 : 0,
    writeTokens: hit ? 200 : 50_000,
    uncachedTokens: 10,
    gapMs: 4_000,
    previousInputTokens: 50_000,
  };
}

describe("nextGatewayAccountChanges", () => {
  test("names the serving account on the first observation", () => {
    expect(nextGatewayAccountChanges(route(a, "2026-11-07T01:00:00Z"), undefined)).toEqual([
      { at: "2026-11-07T01:00:00Z", account: "A" },
    ]);
  });

  test("keeps the switch that brought the session to its first observed account", () => {
    const at = "2026-11-07T01:00:05Z";
    expect(
      nextGatewayAccountChanges(route(b, at, [switchAt(at, "quota", 429)]), undefined),
    ).toEqual([{ at, account: "B", plan: "Max", from: "A", reason: "quota", statusCode: 429 }]);
  });

  test("records only switches newer than the last recorded change", () => {
    const last: GatewayAccountChange = { at: "2026-11-07T01:00:05Z", account: "B", from: "A" };
    const next = switchAt("2026-11-07T01:10:00Z", "cooldown");
    expect(nextGatewayAccountChanges(route(b, next.at, [switchAt(last.at), next]), last)).toEqual([
      { at: next.at, account: "B", plan: "Max", from: "A", reason: "cooldown" },
    ]);
  });

  test("records an account change the Gateway no longer has a switch for, without a reason", () => {
    const last: GatewayAccountChange = { at: "2026-11-07T01:00:00Z", account: "A" };
    expect(nextGatewayAccountChanges(route(b, "2026-11-07T02:30:00Z"), last)).toEqual([
      { at: "2026-11-07T02:30:00Z", account: "B", plan: "Max", from: "A" },
    ]);
  });

  test("starts a native fork's first record at the fork, not at its root's older route", () => {
    const rootSwitch = switchAt("2026-11-07T00:30:00Z", "quota", 429);
    expect(
      nextGatewayAccountChanges(
        route(b, rootSwitch.at, [rootSwitch]),
        undefined,
        "2026-11-07T01:00:00.000Z",
      ),
    ).toEqual([{ at: "2026-11-07T01:00:00.000Z", account: "B", plan: "Max" }]);
  });

  test("records nothing while the same account keeps serving", () => {
    const last: GatewayAccountChange = { at: "2026-11-07T01:00:00Z", account: "A" };
    expect(nextGatewayAccountChanges(route(a, "2026-11-07T01:00:00Z"), last)).toEqual([]);
  });
});

function harness(options: { routed?: boolean } = {}) {
  let listener: ((event: AgentManagerEvent) => void) | null = null;
  const agent = {
    provider: "claude",
    internal: false,
    createdAt: new Date("2026-11-07T00:00:00Z"),
    config: {},
    persistence: { provider: "claude", sessionId: "7f0c" },
    gatewayAccounts: undefined as GatewayAccountChange[] | undefined,
    promptCache: undefined as { history: PromptCacheHistoryEntry[] } | undefined,
  };
  let journal: PromptCacheHistoryEntry[] = [];
  let current: GatewaySessionRoute = route(a, "2026-11-07T01:00:00Z");
  const fetchRoute = vi.fn(
    async (): Promise<GatewaySessionRouteResult> => ({ supported: true, route: current }),
  );
  const agentManager = {
    subscribe: (callback: (event: AgentManagerEvent) => void) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    getAgent: () => agent,
    recordGatewayAccountChange: (_agentId: string, change: GatewayAccountChange) => {
      agent.gatewayAccounts = [...(agent.gatewayAccounts ?? []), change];
    },
    readPromptCacheHistory: async () => ({ requests: journal, compactions: [], accounts: [] }),
  } as unknown as GatewaySessionRouteWatcherDeps["agentManager"];
  const detach = attachGatewaySessionRouteWatcher({
    logger: pino({ level: "silent" }),
    agentManager,
    gateway: () => ({ baseUrl: "http://gateway:8317", apiKey: "sk-test" }),
    isGatewayRouted: () => options.routed ?? true,
    fetchRoute,
    settleMs: 0,
  });
  async function finishTurn(type: "turn_completed" | "turn_failed" = "turn_completed") {
    const calls = fetchRoute.mock.calls.length;
    listener?.({
      type: "agent_stream",
      agentId: "agent-1",
      event: { type, provider: "claude" } as never,
    });
    await vi.waitFor(() => expect(fetchRoute.mock.calls.length).toBe(calls + 1), { timeout: 300 });
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    agent,
    fetchRoute,
    detach,
    finishTurn,
    setRoute: (next: GatewaySessionRoute) => {
      current = next;
    },
    setWindow: (history: PromptCacheHistoryEntry[]) => {
      agent.promptCache = { history };
    },
    setJournal: (requests: PromptCacheHistoryEntry[]) => {
      journal = requests;
    },
  };
}

describe("attachGatewaySessionRouteWatcher", () => {
  test("records the first account once, then each switch once", async () => {
    const h = harness();
    await h.finishTurn();
    await h.finishTurn();
    const at = "2026-11-07T01:05:00Z";
    h.setRoute(route(b, at, [switchAt(at, "cooldown")]));
    await h.finishTurn("turn_failed");
    await h.finishTurn();

    expect(h.agent.gatewayAccounts).toEqual([
      { at: "2026-11-07T01:00:00Z", account: "A" },
      { at, account: "B", plan: "Max", from: "A", reason: "cooldown" },
    ]);
    expect(h.fetchRoute).toHaveBeenLastCalledWith({
      baseUrl: "http://gateway:8317",
      token: "sk-test",
      session: "claude:7f0c",
    });
  });

  test("marks the request a switch cost the cache", async () => {
    const h = harness();
    await h.finishTurn();
    const at = "2026-11-07T01:05:00Z";
    // The daemon records the request a little after the Gateway started it.
    h.setWindow([request("2026-11-07T01:04:00Z", true), request("2026-11-07T01:05:01Z", false)]);
    h.setRoute(route(b, at, [switchAt(at, "quota", 429)]));

    await h.finishTurn();

    expect(h.agent.gatewayAccounts?.at(-1)).toMatchObject({
      account: "B",
      reason: "quota",
      missAt: "2026-11-07T01:05:01Z",
    });
  });

  test("leaves a switch unmarked when the next request still read the cache", async () => {
    const h = harness();
    await h.finishTurn();
    const at = "2026-11-07T01:05:00Z";
    h.setWindow([request("2026-11-07T01:04:00Z", true), request("2026-11-07T01:05:01Z", true)]);
    h.setRoute(route(b, at, [switchAt(at)]));

    await h.finishTurn();

    expect(h.agent.gatewayAccounts?.at(-1)).not.toHaveProperty("missAt");
  });

  test("leaves a miss after the cache window to the expiry", async () => {
    const h = harness();
    await h.finishTurn();
    const at = "2026-11-07T01:05:00Z";
    h.setWindow([
      request("2026-11-07T00:50:00Z", true),
      { ...request("2026-11-07T01:05:01Z", false), gapMs: 15 * 60_000 },
    ]);
    h.setRoute(route(b, at, [switchAt(at)]));

    await h.finishTurn();

    expect(h.agent.gatewayAccounts?.at(-1)).toMatchObject({ account: "B", from: "A" });
    expect(h.agent.gatewayAccounts?.at(-1)).not.toHaveProperty("missAt");
  });

  test("reads the journal when the snapshot window starts after the switch", async () => {
    const h = harness();
    await h.finishTurn();
    const at = "2026-11-07T01:05:00Z";
    h.setWindow([request("2026-11-07T01:30:00Z", true)]);
    h.setJournal([request("2026-11-07T01:04:00Z", true), request("2026-11-07T01:05:02Z", false)]);
    h.setRoute(route(b, at, [switchAt(at)]));

    await h.finishTurn();

    expect(h.agent.gatewayAccounts?.at(-1)?.missAt).toBe("2026-11-07T01:05:02Z");
  });

  test("leaves agents that are not Gateway-routed alone", async () => {
    const h = harness({ routed: false });

    await expect(h.finishTurn()).rejects.toThrow();

    expect(h.agent.gatewayAccounts).toBeUndefined();
  });

  test("stops listening when detached", async () => {
    const h = harness();
    h.detach();

    await expect(h.finishTurn()).rejects.toThrow();

    expect(h.agent.gatewayAccounts).toBeUndefined();
  });
});
