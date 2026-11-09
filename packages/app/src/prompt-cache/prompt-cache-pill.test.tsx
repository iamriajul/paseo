// @vitest-environment jsdom

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import type { AgentPromptCacheState } from "@getpaseo/protocol/agent-cache-warm";
import { PromptCachePill, describeAccountPause } from "./prompt-cache-pill";
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
    Minus: () => ReactModule.createElement("svg"),
    Plus: () => ReactModule.createElement("svg"),
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
      segments: Array<{ text: string; flash?: boolean }>;
      children?: React.ReactNode;
    }) =>
      ReactModule.createElement(
        "div",
        { "data-testid": testID },
        segments.map((s, i) =>
          ReactModule.createElement(
            "span",
            { key: i, "data-flash": String(Boolean(s.flash)) },
            s.text,
          ),
        ),
        children,
      ),
    ComposerTrackRow: ({
      children,
      onPress,
      testID,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        { type: "button", "data-testid": testID, onClick: onPress },
        children,
      ),
  };
});

const { autoCompactState, toggleAutoCompactMock, makeDefaultMock } = vi.hoisted(() => ({
  autoCompactState: {
    current: {
      enabled: false,
      overridden: false,
      hostDefault: false,
      contextTokens: null,
      largeEnough: false,
    } as {
      enabled: boolean;
      overridden: boolean;
      hostDefault: boolean;
      contextTokens: number | null;
      largeEnough: boolean;
    },
  },
  toggleAutoCompactMock: vi.fn(),
  makeDefaultMock: vi.fn(),
}));

vi.mock("./use-prompt-cache-auto-compact", () => ({
  usePromptCacheAutoCompact: () => ({
    ...autoCompactState.current,
    toggle: toggleAutoCompactMock,
    makeDefault: makeDefaultMock,
  }),
}));

vi.mock("@/components/ui/switch", async () => {
  const ReactModule = await import("react");
  return {
    Switch: ({
      value,
      onValueChange,
      disabled,
      testID,
    }: {
      value: boolean;
      onValueChange?: (value: boolean) => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      ReactModule.createElement("button", {
        type: "button",
        role: "switch",
        "aria-checked": value,
        "data-testid": testID,
        disabled: disabled || undefined,
        onClick: () => !disabled && onValueChange?.(!value),
      }),
  };
});

vi.mock("./prompt-cache-insights-dialog", async () => {
  const ReactModule = await import("react");
  return {
    PromptCacheInsightsDialog: ({ revision }: { revision: number }) =>
      ReactModule.createElement("div", { "data-testid": "insights-dialog" }, String(revision)),
  };
});

const { capWarningMinutes, moneyStats, reduceMotion } = vi.hoisted(() => ({
  capWarningMinutes: { current: 10 },
  moneyStats: { current: false },
  reduceMotion: { current: false },
}));

vi.mock("react-native-reanimated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native-reanimated")>()),
  useReducedMotion: () => reduceMotion.current,
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: (
    select: (settings: {
      promptCacheCapWarningMinutes: number;
      promptCacheMoneyStats: boolean;
    }) => unknown,
  ) =>
    select({
      promptCacheCapWarningMinutes: capWarningMinutes.current,
      promptCacheMoneyStats: moneyStats.current,
    }),
  useAppSettings: () => ({
    settings: {
      promptCacheCapWarningMinutes: capWarningMinutes.current,
      promptCacheMoneyStats: moneyStats.current,
    },
  }),
}));

vi.mock("@/components/ui/pane-content-toolbar", async () => {
  const ReactModule = await import("react");
  return {
    ToolbarButton: ({
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
    autoCompactState.current = {
      enabled: false,
      overridden: false,
      hostDefault: false,
      contextTokens: null,
      largeEnough: false,
    };
    vi.mocked(useHostRuntimeClient).mockReturnValue({
      setAgentFeature: setAgentFeatureMock,
    } as unknown as ReturnType<typeof useHostRuntimeClient>);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function renderPill(agent: Agent, features: Record<string, boolean> = {}) {
    useSessionStore.setState({
      sessions: {
        "server-1": {
          agents: new Map([[agent.id, agent]]),
          agentDetails: new Map([[agent.id, agent]]),
          serverInfo: { features },
        } as unknown as SessionState,
      },
    });
    return render(<PromptCachePill serverId="server-1" agentId="agent-1" />);
  }

  it("does not render for non-Claude sessions", () => {
    const { queryByTestId } = renderPill(claudeAgent({ provider: "codex" }));
    expect(queryByTestId("prompt-cache-pill")).toBeNull();
  });

  it("shows Auto with no warm-up controls", () => {
    const { getByText, queryByTestId } = renderPill(
      claudeAgent({ ttl: "default", promptCache: promptCacheAt(NOW) }),
    );
    expect(getByText("cache · auto")).toBeTruthy();
    expect(getByText("Cache · Auto")).toBeTruthy();
    expect(getByText("Choose 5m or 1h under Cache window to warm it.")).toBeTruthy();
    expect(queryByTestId("prompt-cache-toggle-warmup-button")).toBeNull();
  });

  it("counts down to the next warm-up in minutes and seconds", () => {
    const { getByText } = renderPill(
      claudeAgent({ ttl: "5m", promptCache: promptCacheAt(NOW - 40 * SECOND) }),
    );
    expect(getByText("warm · 3:20")).toBeTruthy();
    expect(getByText("Expires in 4:20")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(SECOND);
    });
    expect(getByText("warm · 3:19")).toBeTruthy();
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
    expect(getByTestId("prompt-cache-cap-count").textContent).toBe(
      "Next in 58:00 · 3/12 · covers 11h36m",
    );
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

  it("names the window Claude Code picked under Auto once a write shows it", () => {
    const { getByText } = renderPill(
      claudeAgent({ ttl: "default", promptCache: { ...promptCacheAt(NOW), observedTtl: "1h" } }),
    );
    expect(getByText("Cache · Auto · 1h")).toBeTruthy();
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

  it("shows warm-up paused after the idle-cap compaction until the next message", () => {
    const compactedAt = new Date(NOW - MINUTE).toISOString();
    const { getByText, getByTestId } = renderPill(
      claudeAgent({
        ttl: "5m",
        consecutiveWarmPings: 10,
        promptCache: {
          ...promptCacheAt(NOW - MINUTE),
          lastActivityAt: new Date(NOW - 50 * MINUTE).toISOString(),
          compactions: [{ at: compactedAt, trigger: "manual", atIdleCap: true }],
        },
      }),
    );
    expect(getByText("paused · 4:00")).toBeTruthy();
    expect(getByTestId("prompt-cache-cap-count").textContent).toContain(
      "Paused after compacting · resumes on your next message",
    );
    // Warm-up stays on: the switch is not what resumes it.
    expect(getByTestId("prompt-cache-toggle-warmup-switch").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("sets the warm-up cap from 1 to the window's maximum on a host that enforces it", () => {
    const agent = claudeAgent({
      ttl: "5m",
      cacheWarmMaxPings: 4,
      promptCache: promptCacheAt(NOW - MINUTE),
    });
    const { getByTestId, queryByTestId } = renderPill(agent, { cacheWarmMaxPings: true });
    expect(getByTestId("prompt-cache-cap-slider-value").textContent).toBe("4 of 10 · covers 16m");
    expect(getByTestId("prompt-cache-cap-count").textContent).toContain("0/4");
    expect(queryByTestId("prompt-cache-cap-step-11")).toBeNull();
    fireEvent.click(getByTestId("prompt-cache-cap-step-6"));
    expect(setAgentFeatureMock).toHaveBeenCalledWith("agent-1", "cache_warm_max_pings", 6);
    fireEvent.click(getByTestId("prompt-cache-cap-decrease"));
    expect(setAgentFeatureMock).toHaveBeenLastCalledWith("agent-1", "cache_warm_max_pings", 3);
    cleanup();

    // An older daemon ignores the cap, so it shows no control.
    expect(renderPill(agent).queryByTestId("prompt-cache-cap-slider")).toBeNull();
  });

  it("blinks the countdown once warm-up stops covering the cache within the warning window", () => {
    // 5m window, 8 of 10 warm-ups used, last request 1 minute ago: two more at 4-minute steps,
    // then a 5-minute window, so warm-up covers the cache for 12 more minutes.
    const agent = claudeAgent({
      ttl: "5m",
      consecutiveWarmPings: 8,
      promptCache: promptCacheAt(NOW - MINUTE),
    });
    capWarningMinutes.current = 10;
    const far = renderPill(agent);
    expect(far.getByText("warm · 3:00").getAttribute("data-flash")).toBe("false");
    cleanup();

    capWarningMinutes.current = 20;
    const near = renderPill(agent);
    const flashes = new Set<string | null>();
    for (let tick = 0; tick < 2; tick += 1) {
      flashes.add(near.getByText(/^warm · /).getAttribute("data-flash"));
      act(() => {
        vi.advanceTimersByTime(SECOND);
      });
    }
    expect(flashes).toEqual(new Set(["true", "false"]));
    cleanup();

    // Reduced motion holds the warning colour instead of blinking.
    reduceMotion.current = true;
    const steady = renderPill(agent);
    for (let tick = 0; tick < 2; tick += 1) {
      expect(steady.getByText(/^warm · /).getAttribute("data-flash")).toBe("true");
      act(() => {
        vi.advanceTimersByTime(SECOND);
      });
    }
    reduceMotion.current = false;
    capWarningMinutes.current = 10;
  });

  it("prices warm-up against a rewrite only while money stats are on, for a priced model", () => {
    const agent = claudeAgent({
      ttl: "5m",
      model: "claude-opus-5-5",
      consecutiveWarmPings: 2,
      promptCache: promptCacheAt(NOW - MINUTE),
    });
    moneyStats.current = false;
    expect(renderPill(agent).queryByTestId("prompt-cache-warm-up-cost")).toBeNull();
    cleanup();

    moneyStats.current = true;
    // 183,240 tokens on Opus 5.5 ($4/MTok): a read at 0.05× is $0.037, a 5m write at 1.25× $0.92.
    expect(renderPill(agent).getByTestId("prompt-cache-warm-up-cost").textContent).toBe(
      "≈ $0.04 each · $0.29 to the cap · rewrite ≈ $0.92",
    );
    cleanup();

    // A CLIProxyAPI slug has no price table, so no figures show.
    expect(
      renderPill({ ...agent, model: "grok-4.6" } as Agent).queryByTestId(
        "prompt-cache-warm-up-cost",
      ),
    ).toBeNull();
    moneyStats.current = false;
  });

  it("toggles warm-up, and disables turning it on once the cache expired", () => {
    const live = renderPill(
      claudeAgent({ ttl: "1h", cacheWarm: false, promptCache: promptCacheAt(NOW) }),
    );
    const toggle = live.getByTestId("prompt-cache-toggle-warmup-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(setAgentFeatureMock).toHaveBeenCalledWith("agent-1", "cache_warm", true);
    cleanup();

    const expired = renderPill(
      claudeAgent({ ttl: "1h", cacheWarm: false, promptCache: promptCacheAt(NOW - 61 * MINUTE) }),
    );
    expect(expired.getByText("cache · expired")).toBeTruthy();
    expect(expired.getByTestId("prompt-cache-toggle-warmup-switch").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("shows the question countdown and when warm-up pauses it", () => {
    const { getByText, getByTestId } = renderPill(
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
    expect(getByTestId("prompt-cache-cap-count").textContent).toBe(
      "Question closes in 48:00 · 0/12 · covers 11h36m",
    );
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
    expect(getByTestId("prompt-cache-history-share").textContent).toBe("Last 5 · 79% cached");
    // The first request had no cache to read, so it is no miss.
    expect(getByTestId("prompt-cache-history-misses").textContent).toBe("0 misses this session");
    expect(getByTestId("prompt-cache-pill").querySelectorAll("span")).toHaveLength(1);
  });

  it("puts the session's misses beside the countdown, counted past the snapshot window", () => {
    const { getByTestId } = renderPill(
      claudeAgent({
        ttl: "5m",
        promptCache: {
          ...promptCacheAt(NOW - 40 * SECOND),
          totals: { requests: 300, hits: 290, misses: 4 },
        },
      }),
    );
    const pill = getByTestId("prompt-cache-pill");
    expect(Array.from(pill.querySelectorAll("span")).map((span) => span.textContent)).toEqual([
      "warm · 3:20",
      "4",
    ]);
  });

  it("shows the miss count in red only once it is above zero", () => {
    const { getByTestId } = renderPill(
      claudeAgent({
        ttl: "5m",
        promptCache: {
          ...promptCacheAt(NOW - 40 * SECOND),
          totals: { requests: 300, hits: 300, misses: 0 },
        },
      }),
    );
    const pill = getByTestId("prompt-cache-pill");
    expect(Array.from(pill.querySelectorAll("span")).map((span) => span.textContent)).toEqual([
      "warm · 3:20",
    ]);
  });

  it("switches the idle cap between expiring and compacting", () => {
    autoCompactState.current = {
      enabled: true,
      overridden: true,
      hostDefault: true,
      contextTokens: 312_000,
      largeEnough: true,
    };
    const { getByTestId, queryByTestId } = renderPill(
      claudeAgent({ ttl: "5m", promptCache: promptCacheAt(NOW - 40 * SECOND) }),
    );
    expect(getByTestId("prompt-cache-auto-compact").textContent).toBe(
      "On · compacts instead of expiring · 312k now",
    );
    const toggle = getByTestId("prompt-cache-toggle-auto-compact-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggleAutoCompactMock).toHaveBeenCalledTimes(1);
    // The agent's choice matches the host default, so there is nothing to promote.
    expect(queryByTestId("prompt-cache-auto-compact-make-default")).toBeNull();
  });

  it("offers to make an agent's own idle-cap choice the host default", () => {
    autoCompactState.current = {
      enabled: true,
      overridden: true,
      hostDefault: false,
      contextTokens: 312_000,
      largeEnough: true,
    };
    const { getByTestId } = renderPill(
      claudeAgent({ ttl: "5m", promptCache: promptCacheAt(NOW - 40 * SECOND) }),
    );
    expect(getByTestId("prompt-cache-auto-compact-default").textContent).toContain(
      "This agent only · host default: let it expire",
    );
    fireEvent.click(getByTestId("prompt-cache-auto-compact-make-default"));
    expect(makeDefaultMock).toHaveBeenCalledTimes(1);
  });

  it("clears the miss count from a button on the miss count's own row", () => {
    const clearPromptCacheMisses = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(useHostRuntimeClient).mockReturnValue({
      setAgentFeature: setAgentFeatureMock,
      clearPromptCacheMisses,
    } as unknown as ReturnType<typeof useHostRuntimeClient>);
    const agent = claudeAgent({
      ttl: "5m",
      promptCache: {
        ...promptCacheAt(NOW - 40 * SECOND),
        totals: { requests: 300, hits: 290, misses: 4 },
        history: [
          {
            at: new Date(NOW - MINUTE).toISOString(),
            kind: "turn",
            readTokens: 0,
            writeTokens: 1_000,
            uncachedTokens: 0,
            gapMs: 10 * MINUTE,
          },
        ],
      } as Agent["promptCache"],
    });
    expect(renderPill(agent).queryByTestId("prompt-cache-clear-misses-button")).toBeNull();
    cleanup();

    const { getByTestId } = renderPill(agent, { promptCacheClearMisses: true });
    const button = getByTestId("prompt-cache-clear-misses-button");
    expect(button.tagName).toBe("BUTTON");
    expect(button.textContent).toBe("Clear count");
    expect(button.parentElement?.contains(getByTestId("prompt-cache-history-misses"))).toBe(true);
    fireEvent.click(button);
    expect(clearPromptCacheMisses).toHaveBeenCalledWith({ agentIds: ["agent-1"] });
  });

  it("opens the session insights from the popover", () => {
    const { getByTestId, queryByTestId } = renderPill(
      claudeAgent({
        ttl: "5m",
        promptCache: {
          ...promptCacheAt(NOW - 40 * SECOND),
          totals: { requests: 300, hits: 290, misses: 4 },
        },
      }),
    );
    expect(queryByTestId("insights-dialog")).toBeNull();
    fireEvent.click(getByTestId("prompt-cache-open-insights"));
    expect(getByTestId("insights-dialog").textContent).toBe("300");
  });
});

describe("describeAccountPause", () => {
  const now = new Date("2026-11-07T15:00:00Z").getTime();

  it("names the cooldown and when it ends", () => {
    const text = describeAccountPause(
      { reason: "cooldown", account: "u***a@example.com", until: "2026-11-07T15:43:00Z" },
      now,
    );
    expect(text).toMatch(
      /^Paused · account in cooldown until \S.* · resumes on your next message$/,
    );
  });

  it("names the used-up window", () => {
    expect(
      describeAccountPause(
        {
          reason: "quota",
          account: "u***a@example.com",
          window: "5h",
          until: "2026-11-07T17:00:00Z",
        },
        now,
      ),
    ).toMatch(/^Paused · account's 5h quota used up until \S/);
  });

  it("leaves the time out when the Gateway does not say", () => {
    expect(describeAccountPause({ reason: "cooldown", account: "u***a@example.com" }, now)).toBe(
      "Paused · account in cooldown · resumes on your next message",
    );
  });
});
