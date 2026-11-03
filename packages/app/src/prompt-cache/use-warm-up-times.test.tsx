// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PromptCacheHistoryEntry } from "@getpaseo/protocol/agent-cache-warm";
import { useSessionStore, type SessionState, type Agent } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useWarmUpTimes } from "./use-warm-up-times";

vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: vi.fn() }));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: vi.fn() }));

const MINUTE = 60_000;

function entry(kind: PromptCacheHistoryEntry["kind"], minute: number): PromptCacheHistoryEntry {
  return {
    at: new Date(minute * MINUTE).toISOString(),
    kind,
    readTokens: 1_000,
    writeTokens: 0,
    uncachedTokens: 0,
    gapMs: MINUTE,
  };
}

function setAgent(history: PromptCacheHistoryEntry[], totalWarmPings: number): void {
  const sample = {
    at: history[0]!.at,
    turnId: null,
    isWarmPing: true,
    readTokens: 1,
    writeTokens: 0,
    uncachedTokens: 0,
  };
  const agent = {
    id: "agent-1",
    provider: "claude",
    totalWarmPings,
    promptCache: { lastRequest: sample, turnFirstRequest: sample, history },
  } as unknown as Agent;
  useSessionStore.setState({
    sessions: {
      "server-1": { agents: new Map([[agent.id, agent]]) } as unknown as SessionState,
    },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("useWarmUpTimes", () => {
  const getPromptCacheHistory = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHostFeature).mockReturnValue(true);
    vi.mocked(useHostRuntimeClient).mockReturnValue({
      getPromptCacheHistory,
    } as unknown as ReturnType<typeof useHostRuntimeClient>);
  });

  it("adds the journal's older warm-ups to the snapshot's when the snapshot misses some", async () => {
    getPromptCacheHistory.mockResolvedValue({
      requests: [entry("turn", 0), entry("warm-up", 4), entry("warm-up", 8), entry("warm-up", 12)],
      compactions: [],
    });
    setAgent([entry("warm-up", 12), entry("turn", 14), entry("warm-up", 18)], 4);

    const { result } = renderHook(() => useWarmUpTimes("server-1", "agent-1"), { wrapper });

    await waitFor(() =>
      expect(result.current).toEqual([4 * MINUTE, 8 * MINUTE, 12 * MINUTE, 18 * MINUTE]),
    );
  });

  it("reads only the snapshot when it already holds every warm-up", async () => {
    setAgent([entry("turn", 0), entry("warm-up", 4)], 1);

    const { result } = renderHook(() => useWarmUpTimes("server-1", "agent-1"), { wrapper });

    await waitFor(() => expect(result.current).toEqual([4 * MINUTE]));
    expect(getPromptCacheHistory).not.toHaveBeenCalled();
  });
});
