// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionStore, type SessionState, type Agent } from "@/stores/session-store";
import { useWorkspaceCacheWarmText } from "./use-workspace-cache-warm";

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
  return renderHook(() => useWorkspaceCacheWarmText({ serverId: "server-1", workspaceId: "ws-1" }));
}

describe("useWorkspaceCacheWarmText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down to the next warm-up of an idle agent, every second", () => {
    const { result } = setup(agentWith({}));
    expect(result.current).toBe("3:50");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe("3:49");
  });

  it("shows nothing while a turn runs, warm-up is off, or the window is Automatic", () => {
    expect(setup(agentWith({ status: "running" })).result.current).toBeNull();
    expect(
      setup(
        agentWith({
          features: [
            { type: "select", id: "prompt_cache_ttl", value: "5m" },
            { type: "toggle", id: "cache_warm", value: false },
          ] as Agent["features"],
        }),
      ).result.current,
    ).toBeNull();
    expect(
      setup(
        agentWith({
          features: [
            { type: "select", id: "prompt_cache_ttl", value: "default" },
          ] as Agent["features"],
        }),
      ).result.current,
    ).toBeNull();
  });

  it("reads the current time when the window changes while nothing was ticking", () => {
    const automatic = agentWith({
      features: [{ type: "select", id: "prompt_cache_ttl", value: "default" }] as Agent["features"],
    });
    const { result } = setup(automatic);
    expect(result.current).toBeNull();

    vi.setSystemTime(NOW + 6 * 60_000);
    const session = useSessionStore.getState().sessions["server-1"];
    const switchedToFiveMinutes = {
      sessions: { "server-1": { ...session, agents: new Map([["agent-1", agentWith({})]]) } },
    };
    act(() => useSessionStore.setState(switchedToFiveMinutes));
    expect(result.current).toBeNull();
  });
});
