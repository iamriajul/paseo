// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentPromptCacheState } from "@getpaseo/protocol/agent-cache-warm";
import { usePromptCache } from "./use-prompt-cache";
import { useSessionStore, type SessionState, type Agent } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: vi.fn(),
}));

const NOW = new Date("2026-10-27T10:00:00.000Z").getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function promptCacheAt(atMs: number, readTokens = 1000): AgentPromptCacheState {
  const sample = {
    at: new Date(atMs).toISOString(),
    turnId: "turn-1",
    isWarmPing: false,
    readTokens,
    writeTokens: 10,
    uncachedTokens: 1,
  };
  return { lastRequest: sample, turnFirstRequest: sample };
}

function claudeAgent(overrides: Partial<Agent> & { ttl?: string; cacheWarm?: boolean }): Agent {
  const { ttl, cacheWarm, ...rest } = overrides;
  const features = [
    ...(ttl ? [{ type: "select", id: "prompt_cache_ttl", value: ttl }] : []),
    ...(cacheWarm !== undefined ? [{ type: "toggle", id: "cache_warm", value: cacheWarm }] : []),
  ];
  return {
    id: "agent-1",
    provider: "claude",
    status: "idle",
    labels: {},
    pendingPermissions: [],
    features,
    ...rest,
  } as unknown as Agent;
}

describe("usePromptCache", () => {
  const setAgentFeatureMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    vi.mocked(useHostRuntimeClient).mockReturnValue({
      setAgentFeature: setAgentFeatureMock,
    } as unknown as ReturnType<typeof useHostRuntimeClient>);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupSession(agent: Agent) {
    useSessionStore.setState({
      sessions: {
        "server-1": {
          agents: new Map([[agent.id, agent]]),
          agentDetails: new Map([[agent.id, agent]]),
        } as unknown as SessionState,
      },
    });
  }

  it("ignores non-Claude providers and gateway models", () => {
    setupSession(claudeAgent({ provider: "codex" }));
    expect(renderHook(() => usePromptCache("server-1", "agent-1")).result.current.isClaude).toBe(
      false,
    );
    setupSession(claudeAgent({ model: "gemini-3.8-flash-high" }));
    expect(renderHook(() => usePromptCache("server-1", "agent-1")).result.current.isClaude).toBe(
      false,
    );
  });

  it("offers no countdown or warm-up while the Cache window is Automatic", () => {
    setupSession(claudeAgent({ ttl: "default", cacheWarm: true, promptCache: promptCacheAt(NOW) }));
    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.status).toEqual({ kind: "automatic" });
    expect(result.current.warmup).toBeNull();
  });

  it("keeps counting through a long tool call and reports the expiry inside the turn", () => {
    setupSession(
      claudeAgent({ ttl: "5m", status: "running", promptCache: promptCacheAt(NOW - 4 * MINUTE) }),
    );
    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.status).toEqual({ kind: "busy", remainingMs: MINUTE });
    expect(result.current.warmup?.plan).toEqual({ kind: "after-turn" });
    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(result.current.status).toEqual({ kind: "busy-expired" });
  });

  it("times an Automatic window on the TTL Claude Code was seen writing", () => {
    setupSession(
      claudeAgent({
        ttl: "default",
        promptCache: { ...promptCacheAt(NOW - 10 * MINUTE), observedTtl: "1h" },
      }),
    );
    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.status).toEqual({ kind: "warm", remainingMs: 50 * MINUTE });
    expect(result.current.warmup).toBeNull();
  });

  it("times a just-changed window on the TTL the running process still writes", () => {
    setupSession(
      claudeAgent({
        ttl: "1h",
        promptCache: { ...promptCacheAt(NOW - 6 * MINUTE), observedTtl: "5m" },
      }),
    );
    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.status).toEqual({ kind: "expired" });
  });

  it("counts a 5m window down from the last request, warming at 4m30s", () => {
    setupSession(claudeAgent({ ttl: "5m", promptCache: promptCacheAt(NOW - 40 * SECOND) }));
    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.status).toEqual({ kind: "warm", remainingMs: 4 * MINUTE + 20 * SECOND });
    expect(result.current.warmup).toMatchObject({
      enabled: true,
      plan: { kind: "next-ping", remainingMs: 3 * MINUTE + 50 * SECOND },
      pingsUsed: 0,
      maxPings: 10,
    });
  });

  it("ticks every second", () => {
    setupSession(claudeAgent({ ttl: "1h", promptCache: promptCacheAt(NOW) }));
    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    act(() => {
      vi.advanceTimersByTime(3 * SECOND);
    });
    expect(result.current.status).toEqual({ kind: "warm", remainingMs: 60 * MINUTE - 3 * SECOND });
  });

  it("anchors on the last request even when the turn ended later", () => {
    setupSession(
      claudeAgent({
        ttl: "1h",
        promptCache: promptCacheAt(NOW - 3 * MINUTE),
        lastResponseAt: new Date(NOW),
      }),
    );
    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.status).toEqual({ kind: "warm", remainingMs: 57 * MINUTE });
  });

  it("reports cap progress and a capped plan once the idle stretch is used up", () => {
    setupSession(
      claudeAgent({ ttl: "5m", consecutiveWarmPings: 3, promptCache: promptCacheAt(NOW) }),
    );
    const { result, rerender } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.warmup).toMatchObject({ pingsUsed: 3, maxPings: 10 });

    setupSession(
      claudeAgent({ ttl: "5m", consecutiveWarmPings: 10, promptCache: promptCacheAt(NOW) }),
    );
    rerender();
    expect(result.current.warmup?.plan).toEqual({ kind: "capped" });
  });

  it("says the parent answers a child agent's question instead of pausing it", () => {
    const pendingPermissions = [{ id: "q-1", kind: "question", name: "AskUserQuestion" }];
    setupSession(
      claudeAgent({
        ttl: "5m",
        labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" },
        pendingPermissions: pendingPermissions as Agent["pendingPermissions"],
        promptCache: promptCacheAt(NOW),
      }),
    );
    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.status.kind).toBe("awaiting-question");
    expect(result.current.warmup?.plan).toEqual({ kind: "parent-answers" });
  });

  it("exposes the latest turn's first request as the last prompt", () => {
    const promptCache = promptCacheAt(NOW, 0);
    setupSession(claudeAgent({ ttl: "1h", promptCache }));
    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.lastPrompt).toEqual(promptCache.turnFirstRequest);
  });

  it("toggles warm-up, but will not turn it on for an expired cache", async () => {
    setupSession(claudeAgent({ ttl: "1h", cacheWarm: false, promptCache: promptCacheAt(NOW) }));
    const live = renderHook(() => usePromptCache("server-1", "agent-1"));
    await act(() => live.result.current.toggleWarmup());
    expect(setAgentFeatureMock).toHaveBeenCalledWith("agent-1", "cache_warm", true);

    setAgentFeatureMock.mockClear();
    setupSession(
      claudeAgent({ ttl: "1h", cacheWarm: false, promptCache: promptCacheAt(NOW - 61 * MINUTE) }),
    );
    const expired = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(expired.result.current.status).toEqual({ kind: "expired" });
    await act(() => expired.result.current.toggleWarmup());
    expect(setAgentFeatureMock).not.toHaveBeenCalled();
  });
});
