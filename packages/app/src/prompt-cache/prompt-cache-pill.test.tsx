// @vitest-environment jsdom

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import type { AgentPromptCacheState } from "@getpaseo/protocol/agent-cache-warm";
import { PromptCachePill } from "./prompt-cache-pill";
import { useSessionStore, type SessionState, type Agent } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

const { theme } = vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
  return {
    theme: {
      spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
      fontSize: { xs: 11, sm: 12, base: 14 },
      fontWeight: { semibold: "600", medium: "500" },
      borderRadius: { md: 6, lg: 8, xl: 12, full: 9999 },
      borderWidth: { 1: 1 },
      opacity: { 0: 0, 50: 0.5, 100: 1 },
      colors: {
        surface0: "#000",
        surface1: "#111",
        surface3: "#333",
        foreground: "#fff",
        foregroundMuted: "#aaa",
        border: "#555",
        borderAccent: "#777",
        accent: "#20744a",
        statusWarning: "#c09664",
      },
    },
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: vi.fn(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (Component: unknown) => Component,
}));

vi.mock("lucide-react-native", async () => {
  const ReactModule = await import("react");
  return {
    Database: (props: Record<string, unknown>) =>
      ReactModule.createElement("svg", { "data-testid": "icon-database", ...props }),
    Flame: (props: Record<string, unknown>) =>
      ReactModule.createElement("svg", { "data-testid": "icon-flame", ...props }),
  };
});

vi.mock("@/composer/tracks", async () => {
  const ReactModule = await import("react");
  return {
    ComposerTrackPill: ({
      testID,
      segments,
      children,
    }: {
      testID?: string;
      segments: Array<{ text: string }>;
      children?: React.ReactNode;
    }) =>
      ReactModule.createElement(
        "div",
        { "data-testid": testID },
        segments.map((s, i) => ReactModule.createElement("span", { key: i }, s.text)),
        children,
      ),
    ComposerTrackRow: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
  };
});

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      disabled,
      testID,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        {
          type: "button",
          "data-testid": testID,
          disabled: disabled || undefined,
          onClick: () => !disabled && onPress?.(),
        },
        children,
      ),
  };
});

const NOW = new Date("2026-10-27T10:00:00.000Z").getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function promptCacheAt(
  atMs: number,
  tokens: { readTokens: number; writeTokens: number; uncachedTokens: number } = {
    readTokens: 182_000,
    writeTokens: 1_200,
    uncachedTokens: 40,
  },
  isWarmPing = false,
): AgentPromptCacheState {
  const sample = { at: new Date(atMs).toISOString(), turnId: "turn-1", isWarmPing, ...tokens };
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

describe("PromptCachePill", () => {
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
    cleanup();
    vi.useRealTimers();
  });

  function renderPill(agent: Agent) {
    useSessionStore.setState({
      sessions: {
        "server-1": {
          agents: new Map([[agent.id, agent]]),
          agentDetails: new Map([[agent.id, agent]]),
        } as unknown as SessionState,
      },
    });
    return render(<PromptCachePill serverId="server-1" agentId="agent-1" />);
  }

  it("does not render for non-Claude sessions", () => {
    const { queryByTestId } = renderPill(claudeAgent({ provider: "codex" }));
    expect(queryByTestId("prompt-cache-pill")).toBeNull();
  });

  it("shows Automatic with no warm-up controls", () => {
    const { getByText, queryByTestId } = renderPill(
      claudeAgent({ ttl: "default", promptCache: promptCacheAt(NOW) }),
    );
    expect(getByText("cache · auto")).toBeTruthy();
    expect(getByText("Automatic")).toBeTruthy();
    expect(
      getByText("Choose 5 minutes or 1 hour under Cache window to use auto warm-up."),
    ).toBeTruthy();
    expect(queryByTestId("prompt-cache-toggle-warmup-button")).toBeNull();
  });

  it("counts down to the next warm-up in minutes and seconds", () => {
    const { getByText } = renderPill(
      claudeAgent({ ttl: "5m", promptCache: promptCacheAt(NOW - 40 * SECOND) }),
    );
    expect(getByText("warm · 3:50")).toBeTruthy();
    expect(getByText("Expires in 4:20")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(SECOND);
    });
    expect(getByText("warm · 3:49")).toBeTruthy();
  });

  it("shows how far into the idle cap the warm-ups are", () => {
    const { getByTestId } = renderPill(
      claudeAgent({
        ttl: "1h",
        cacheWarm: true,
        consecutiveWarmPings: 3,
        totalWarmPings: 27,
        promptCache: promptCacheAt(NOW),
      }),
    );
    expect(getByTestId("prompt-cache-cap-count").textContent).toBe("3 / 12 · 11h36m");
    expect(getByTestId("prompt-cache-total-pings").textContent).toBe("27");
    expect(getByTestId("prompt-cache-cap-progress").getAttribute("aria-valuenow")).toBe("3");
  });

  it("reports whether the last prompt hit the cache", () => {
    const hit = renderPill(claudeAgent({ ttl: "1h", promptCache: promptCacheAt(NOW) }));
    expect(hit.getByTestId("prompt-cache-last-prompt").textContent).toBe(
      "99% cached · 182k read · 1k written",
    );
    cleanup();

    const miss = renderPill(
      claudeAgent({
        ttl: "1h",
        promptCache: promptCacheAt(NOW, { readTokens: 0, writeTokens: 180_000, uncachedTokens: 3 }),
      }),
    );
    expect(miss.getByText("Last prompt")).toBeTruthy();
    expect(miss.getByTestId("prompt-cache-last-prompt").textContent).toBe("Missed · wrote 180k");
    cleanup();

    const ping = renderPill(
      claudeAgent({
        ttl: "1h",
        promptCache: promptCacheAt(NOW, undefined, true),
      }),
    );
    expect(ping.getByText("Last warm-up")).toBeTruthy();
  });

  it("shows caching while a turn is in flight before its first request", () => {
    const { getByText } = renderPill(claudeAgent({ ttl: "1h", status: "running" }));
    expect(getByText("caching")).toBeTruthy();
  });

  it("counts the cache down during a turn and says when it expired inside it", () => {
    const { getByText } = renderPill(
      claudeAgent({ ttl: "5m", status: "running", promptCache: promptCacheAt(NOW - 4 * MINUTE) }),
    );
    expect(getByText("cache · 1:00")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(getByText("cache · expired")).toBeTruthy();
    expect(getByText("Expired during this turn · the next request writes it again")).toBeTruthy();
  });

  it("names the window Claude Code picked under Automatic once a write shows it", () => {
    const { getByText } = renderPill(
      claudeAgent({ ttl: "default", promptCache: { ...promptCacheAt(NOW), observedTtl: "1h" } }),
    );
    expect(getByText("Automatic · 1 hour")).toBeTruthy();
  });

  it("shows a capped segment with the time the cache has left", () => {
    const { getByText } = renderPill(
      claudeAgent({
        ttl: "5m",
        consecutiveWarmPings: 10,
        promptCache: promptCacheAt(NOW - MINUTE),
      }),
    );
    expect(getByText("capped · 4:00")).toBeTruthy();
  });

  it("toggles warm-up, and disables turning it on once the cache expired", () => {
    const live = renderPill(
      claudeAgent({ ttl: "1h", cacheWarm: false, promptCache: promptCacheAt(NOW) }),
    );
    fireEvent.click(live.getByTestId("prompt-cache-toggle-warmup-button"));
    expect(setAgentFeatureMock).toHaveBeenCalledWith("agent-1", "cache_warm", true);
    cleanup();

    const expired = renderPill(
      claudeAgent({ ttl: "1h", cacheWarm: false, promptCache: promptCacheAt(NOW - 61 * MINUTE) }),
    );
    expect(expired.getByText("cache · expired")).toBeTruthy();
    expect(expired.getByTestId("prompt-cache-toggle-warmup-button").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("shows the question countdown and when warm-up pauses it", () => {
    const { getByText } = renderPill(
      claudeAgent({
        ttl: "1h",
        cacheWarm: true,
        pendingPermissions: [
          { id: "q-1", kind: "question", name: "AskUserQuestion" },
        ] as Agent["pendingPermissions"],
        promptCache: promptCacheAt(NOW - 10 * MINUTE),
      }),
    );
    expect(getByText("question · 50:00")).toBeTruthy();
    expect(getByText("Question closes in 48:00")).toBeTruthy();
  });

  it("shows how recent requests met the cache, including returns kept warm by warm-ups", () => {
    const entry = (
      minutesAgo: number,
      kind: "turn" | "request" | "warm-up",
      readTokens: number,
      gapMinutes: number | null,
      awayMinutes?: number,
    ) => ({
      at: new Date(NOW - minutesAgo * MINUTE).toISOString(),
      kind,
      readTokens,
      writeTokens: 1_000 - readTokens,
      uncachedTokens: 0,
      gapMs: gapMinutes === null ? null : gapMinutes * MINUTE,
      ...(awayMinutes === undefined ? {} : { awayMs: awayMinutes * MINUTE }),
    });
    const { getByTestId } = renderPill(
      claudeAgent({
        ttl: "5m",
        promptCache: {
          ...promptCacheAt(NOW - MINUTE),
          history: [
            entry(20, "turn", 0, null),
            entry(19, "request", 1_000, 1),
            entry(14.5, "warm-up", 1_000, 4.5),
            entry(10, "warm-up", 1_000, 4.5),
            entry(8, "turn", 990, 2, 11),
          ],
        },
      }),
    );
    expect(getByTestId("prompt-cache-history-chart").children).toHaveLength(5);
    expect(getByTestId("prompt-cache-history-share").textContent).toBe("5 · 79% of input cached");
    expect(getByTestId("prompt-cache-history-requests").textContent).toBe("4 of 5 hit");
    expect(getByTestId("prompt-cache-history-returns").textContent).toBe("1 of 1 hit");
    expect(getByTestId("prompt-cache-history-warm-ups").textContent).toBe("2 of 2 hit");
    expect(getByTestId("prompt-cache-history-misses").textContent).toBe(
      "1 after expiry · 0 while warm",
    );
    expect(getByTestId("prompt-cache-history-last-return").textContent).toBe(
      "11m away · 2 warm-ups · 99% cached",
    );
  });
});
