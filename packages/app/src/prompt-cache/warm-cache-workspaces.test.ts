// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import {
  indexWorkspaceCacheExpiry,
  selectWarmCacheWorkspaces,
  useWarmCacheWorkspaces,
} from "./warm-cache-workspaces";

const NOW = new Date("2026-11-23T10:00:00.000Z").getTime();
const MINUTE = 60_000;

/** A Claude agent whose last request was `minutesAgo` ago, on a `ttl` cache window. */
function agent(input: {
  id: string;
  workspaceId: string;
  minutesAgo: number;
  ttl?: "5m" | "1h";
  overrides?: Partial<Agent>;
}): Agent {
  const sample = {
    at: new Date(NOW - input.minutesAgo * MINUTE).toISOString(),
    turnId: "turn-1",
    isWarmPing: false,
    readTokens: 1000,
    writeTokens: 10,
    uncachedTokens: 1,
  };
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    provider: "claude",
    status: "idle",
    labels: {},
    pendingPermissions: [],
    features: [{ type: "select", id: "prompt_cache_ttl", value: input.ttl ?? "5m" }],
    promptCache: { lastRequest: sample, turnFirstRequest: sample },
    ...input.overrides,
  } as unknown as Agent;
}

describe("warm-cache workspaces", () => {
  it("keeps a workspace while any of its agents' caches is inside its window", () => {
    const expiry = indexWorkspaceCacheExpiry([
      {
        serverId: "a",
        agents: [
          agent({ id: "warm", workspaceId: "ws-warm", minutesAgo: 2 }),
          agent({ id: "cold", workspaceId: "ws-cold", minutesAgo: 6 }),
          // A cold root agent and a warm second chat: the workspace still holds a warm cache.
          agent({ id: "root", workspaceId: "ws-mixed", minutesAgo: 30 }),
          agent({ id: "hour", workspaceId: "ws-mixed", minutesAgo: 30, ttl: "1h" }),
          agent({
            id: "archived",
            workspaceId: "ws-archived",
            minutesAgo: 1,
            overrides: { archivedAt: new Date(NOW) } as Partial<Agent>,
          }),
          agent({
            id: "codex",
            workspaceId: "ws-codex",
            minutesAgo: 1,
            overrides: { provider: "codex" } as Partial<Agent>,
          }),
          // A side question's cache is the main chat's, read once; it keeps no workspace warm.
          agent({
            id: "side",
            workspaceId: "ws-side",
            minutesAgo: 1,
            overrides: { labels: { "paseo.side-question-of": "main" } } as Partial<Agent>,
          }),
        ],
      },
      // The same workspace id on another host is another workspace.
      { serverId: "b", agents: [agent({ id: "other", workspaceId: "ws-cold", minutesAgo: 1 })] },
    ]);
    const warm = selectWarmCacheWorkspaces(expiry, NOW);
    expect([...warm.keys].sort()).toEqual(["a:ws-mixed", "a:ws-warm", "b:ws-cold"]);
    // ws-warm goes first: its request 2 minutes ago plus a 5-minute window.
    expect(warm.nextExpiryMs).toBe(NOW + 3 * MINUTE);
    expect(selectWarmCacheWorkspaces(expiry, NOW + 10 * MINUTE)).toEqual({
      keys: new Set(["a:ws-mixed"]),
      nextExpiryMs: NOW + 30 * MINUTE,
    });
  });
});

describe("useWarmCacheWorkspaces", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useSessionStore.setState({
      sessions: {
        "server-1": {
          agents: new Map([
            ["a1", agent({ id: "a1", workspaceId: "ws-1", minutesAgo: 4 })],
            ["a2", agent({ id: "a2", workspaceId: "ws-2", minutesAgo: 2 })],
          ]),
        } as unknown as SessionState,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a workspace the moment its cache expires, with no per-second clock", () => {
    const { result } = renderHook(() => useWarmCacheWorkspaces(true));
    expect([...result.current.keys].sort()).toEqual(["server-1:ws-1", "server-1:ws-2"]);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(MINUTE + 100);
    });
    expect([...result.current.keys]).toEqual(["server-1:ws-2"]);
    act(() => {
      vi.advanceTimersByTime(2 * MINUTE);
    });
    expect(result.current.keys.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("indexes nothing while the filter is off", () => {
    const { result } = renderHook(() => useWarmCacheWorkspaces(false));
    expect(result.current).toEqual({ keys: new Set(), nextExpiryMs: null });
  });
});
