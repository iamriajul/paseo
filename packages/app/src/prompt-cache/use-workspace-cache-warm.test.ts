// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionStore, type SessionState, type Agent } from "@/stores/session-store";
import { useWorkspaceCacheWarm } from "./use-workspace-cache-warm";

const { capWarningMinutes, reduceMotion } = vi.hoisted(() => ({
  capWarningMinutes: { current: 10 },
  reduceMotion: { current: false },
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: (select: (settings: { promptCacheCapWarningMinutes: number }) => unknown) =>
    select({ promptCacheCapWarningMinutes: capWarningMinutes.current }),
}));

vi.mock("react-native-reanimated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native-reanimated")>()),
  useReducedMotion: () => reduceMotion.current,
}));

const NOW = new Date("2026-10-27T10:00:00.000Z").getTime();

function agentWith(overrides: Partial<Agent>): Agent {
  const sample = {
    at: new Date(NOW - 40_000).toISOString(),
    turnId: "turn-1",
    isWarmPing: false,
    readTokens: 1000,
    writeTokens: 10,
    uncachedTokens: 1,
  };
  return {
    id: "agent-1",
    provider: "claude",
    status: "idle",
    labels: {},
    pendingPermissions: [],
    features: [{ type: "select", id: "prompt_cache_ttl", value: "5m" }],
    promptCache: { lastRequest: sample, turnFirstRequest: sample },
    ...overrides,
  } as unknown as Agent;
}

function setup(agent: Agent) {
  useSessionStore.setState({
    sessions: {
      "server-1": {
        agents: new Map([[agent.id, agent]]),
        agentDetails: new Map(),
        workspaceAgentActivity: new Map([["ws-1", { agentId: agent.id }]]),
      } as unknown as SessionState,
    },
  });
  return renderHook(() => useWorkspaceCacheWarm({ serverId: "server-1", workspaceId: "ws-1" }));
}

describe("useWorkspaceCacheWarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down to the next warm-up of an idle agent, every second", () => {
    const { result } = setup(agentWith({}));
    expect(result.current.text).toBe("3:20");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.text).toBe("3:19");
  });

  it("shows nothing while a turn runs, warm-up is off, or the window is Automatic", () => {
    expect(setup(agentWith({ status: "running" })).result.current.text).toBeNull();
    expect(
      setup(
        agentWith({
          features: [
            { type: "select", id: "prompt_cache_ttl", value: "5m" },
            { type: "toggle", id: "cache_warm", value: false },
          ] as Agent["features"],
        }),
      ).result.current.text,
    ).toBeNull();
    expect(
      setup(
        agentWith({
          features: [
            { type: "select", id: "prompt_cache_ttl", value: "default" },
          ] as Agent["features"],
        }),
      ).result.current.text,
    ).toBeNull();
  });

  it("reads the current time when the window changes while nothing was ticking", () => {
    const automatic = agentWith({
      features: [{ type: "select", id: "prompt_cache_ttl", value: "default" }] as Agent["features"],
    });
    const { result } = setup(automatic);
    expect(result.current.text).toBeNull();

    vi.setSystemTime(NOW + 6 * 60_000);
    const session = useSessionStore.getState().sessions["server-1"];
    const switchedToFiveMinutes = {
      sessions: { "server-1": { ...session, agents: new Map([["agent-1", agentWith({})]]) } },
    };
    act(() => useSessionStore.setState(switchedToFiveMinutes));
    expect(result.current.text).toBeNull();
  });

  it("carries the session's misses even when no warm-up is armed", () => {
    const missed = agentWith({ status: "running" });
    missed.promptCache = {
      ...(missed.promptCache as NonNullable<Agent["promptCache"]>),
      totals: { requests: 12, hits: 9, misses: 3 },
    };
    expect(setup(missed).result.current).toEqual({
      text: null,
      capped: false,
      flash: false,
      misses: 3,
    });
  });

  it("blinks by the pill's rule once warm-up stops covering the cache within the warning window", () => {
    // 5m window, 8 of 10 warm-ups used, last request 40 s ago: two more at 4-minute steps, then a
    // 5-minute window, so warm-up covers the cache for 12m20s more.
    const agent = agentWith({ consecutiveWarmPings: 8 } as Partial<Agent>);
    capWarningMinutes.current = 10;
    const far = setup(agent);
    expect(far.result.current.flash).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(far.result.current.flash).toBe(false);
    far.unmount();

    capWarningMinutes.current = 20;
    const near = setup(agent);
    const flashes = new Set<boolean>();
    for (let tick = 0; tick < 2; tick += 1) {
      flashes.add(near.result.current.flash);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(flashes).toEqual(new Set([true, false]));
    near.unmount();

    // Reduced motion holds the warning colour instead of blinking.
    reduceMotion.current = true;
    const steady = setup(agent);
    for (let tick = 0; tick < 2; tick += 1) {
      expect(steady.result.current.flash).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    steady.unmount();
    reduceMotion.current = false;
    capWarningMinutes.current = 10;
  });

  it("counts down to the cache expiring once the cap is spent, blinking near the end", () => {
    const agent = agentWith({ consecutiveWarmPings: 10 } as Partial<Agent>);
    const { result } = setup(agent);
    expect(result.current).toMatchObject({ text: "4:20", capped: true });
    const flashes = new Set<boolean>();
    for (let tick = 0; tick < 2; tick += 1) {
      flashes.add(result.current.flash);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(flashes).toEqual(new Set([true, false]));
    expect(result.current.text).toBe("4:18");
  });
});
