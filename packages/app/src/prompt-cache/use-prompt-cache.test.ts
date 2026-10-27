// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePromptCache } from "./use-prompt-cache";
import { useSessionStore, type SessionState, type Agent } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: vi.fn(),
}));

describe("usePromptCache", () => {
  const setAgentFeatureMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHostRuntimeClient).mockReturnValue({
      setAgentFeature: setAgentFeatureMock,
    } as unknown as ReturnType<typeof useHostRuntimeClient>);
  });

  function setupSession(agent: Partial<Agent> & { id: string }) {
    useSessionStore.setState({
      sessions: {
        "server-1": {
          agents: new Map([[agent.id, agent as Agent]]),
          agentDetails: new Map([[agent.id, agent as Agent]]),
        } as unknown as SessionState,
      },
    });
  }

  it("returns isClaude false for non-Claude agents", () => {
    setupSession({
      id: "agent-1",
      provider: "codex",
      labels: {},
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.isClaude).toBe(false);
  });

  it("returns isClaude false for Claude provider with non-Claude gateway model", () => {
    setupSession({
      id: "agent-1",
      provider: "claude",
      model: "gemini-3.8-flash-high",
      labels: {},
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.isClaude).toBe(false);
  });

  it("defaults to 1-hour cache window and 58m warm interval for Claude sessions", () => {
    const now = Date.now();
    setupSession({
      id: "agent-1",
      provider: "claude",
      labels: {},
      lastResponseAt: new Date(now),
      features: [],
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.isClaude).toBe(true);
    expect(result.current.isSubagent).toBe(false);
    expect(result.current.cacheWindowMs).toBe(60 * 60 * 1000);
    expect(result.current.warmIntervalMs).toBe(58 * 60 * 1000);
    expect(result.current.isWarm).toBe(true);
    expect(result.current.countdownText).toBe("in 60m");
    expect(result.current.nextPingCountdownText).toBe("in 58m");
  });

  it("overrides to 5-minute cache window and 4m warm interval for Claude subagents", () => {
    const now = Date.now();
    setupSession({
      id: "agent-sub-1",
      provider: "claude",
      labels: { "paseo.parent-agent-id": "parent-1" },
      lastResponseAt: new Date(now),
      features: [],
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-sub-1"));
    expect(result.current.isClaude).toBe(true);
    expect(result.current.isSubagent).toBe(true);
    expect(result.current.cacheWindowMs).toBe(5 * 60 * 1000);
    expect(result.current.warmIntervalMs).toBe(4 * 60 * 1000);
    expect(result.current.isWarm).toBe(true);
    expect(result.current.countdownText).toBe("in 5m");
    expect(result.current.nextPingCountdownText).toBe("in 4m");
    expect(result.current.isWarmupEnabled).toBe(true);
  });

  it("respects explicit 5m prompt_cache_ttl on main session", () => {
    const now = Date.now();
    setupSession({
      id: "agent-1",
      provider: "claude",
      labels: {},
      lastResponseAt: new Date(now),
      features: [
        {
          type: "select",
          id: "prompt_cache_ttl",
          label: "TTL",
          options: [{ id: "5m", label: "5m" }],
          value: "5m",
        },
      ],
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.cacheWindowMs).toBe(5 * 60 * 1000);
    expect(result.current.warmIntervalMs).toBe(4 * 60 * 1000);
    expect(result.current.isWarmupEnabled).toBe(true);
  });

  it("respects explicit cache_warm: false on subagent", () => {
    const now = Date.now();
    setupSession({
      id: "agent-sub-1",
      provider: "claude",
      labels: { "paseo.parent-agent-id": "parent-1" },
      lastResponseAt: new Date(now),
      features: [
        {
          type: "toggle",
          id: "cache_warm",
          label: "Cache warm-up",
          value: false,
        },
      ],
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-sub-1"));
    expect(result.current.isWarmupEnabled).toBe(false);
  });

  it("reports expired when cache window elapsed", () => {
    // 70 minutes ago
    const past = Date.now() - 70 * 60 * 1000;
    setupSession({
      id: "agent-1",
      provider: "claude",
      labels: {},
      lastResponseAt: new Date(past),
      features: [],
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.isWarm).toBe(false);
    expect(result.current.countdownText).toBe("expired");
  });

  it("calls setAgentFeature when toggleWarmup is invoked on warm session", async () => {
    setupSession({
      id: "agent-1",
      provider: "claude",
      labels: {},
      lastResponseAt: new Date(),
      features: [{ type: "toggle", id: "cache_warm", label: "Keep warm", value: false }],
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.isWarmupEnabled).toBe(false);

    await act(async () => {
      await result.current.toggleWarmup();
    });

    expect(setAgentFeatureMock).toHaveBeenCalledWith("agent-1", "cache_warm", true);
  });

  it("does not call setAgentFeature when toggleWarmup is invoked on expired cache", async () => {
    setupSession({
      id: "agent-1",
      provider: "claude",
      labels: {},
      lastResponseAt: new Date(Date.now() - 70 * 60 * 1000), // expired
      features: [{ type: "toggle", id: "cache_warm", label: "Keep warm", value: false }],
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.isWarm).toBe(false);

    await act(async () => {
      await result.current.toggleWarmup();
    });

    expect(setAgentFeatureMock).not.toHaveBeenCalled();
  });

  it("does not mark isBusy when awaiting question response", () => {
    const now = Date.now();
    setupSession({
      id: "agent-1",
      provider: "claude",
      status: "running",
      turn: {
        phase: "open",
        turnId: "turn-1",
        startedAt: new Date(now),
        cancellationRequestId: null,
      },
      pendingPermissions: [
        {
          id: "perm-1",
          kind: "question",
          name: "AskUserQuestion",
        } as unknown as import("@getpaseo/protocol/agent-types").AgentPermissionRequest,
      ],
      lastResponseAt: new Date(now - 10 * 60 * 1000), // 10m ago
      labels: {},
    });

    const { result } = renderHook(() => usePromptCache("server-1", "agent-1"));
    expect(result.current.isBusy).toBe(false);
    expect(result.current.hasPendingQuestion).toBe(true);
    expect(result.current.hasPendingPermission).toBe(true);
    expect(result.current.isWarm).toBe(true);
    expect(result.current.countdownText).toBe("in 50m");
  });
});
