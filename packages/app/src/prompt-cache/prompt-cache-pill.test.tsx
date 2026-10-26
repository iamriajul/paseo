// @vitest-environment jsdom

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
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

describe("PromptCachePill", () => {
  const setAgentFeatureMock = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHostRuntimeClient).mockReturnValue({
      setAgentFeature: setAgentFeatureMock,
    } as unknown as ReturnType<typeof useHostRuntimeClient>);
  });

  afterEach(() => {
    cleanup();
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

  it("does not render for non-Claude sessions", () => {
    setupSession({
      id: "agent-1",
      provider: "codex",
      labels: {},
      features: [{ type: "toggle", id: "cache_warm", label: "Cache keep-alive", value: true }],
    });

    const { queryByTestId } = render(<PromptCachePill serverId="server-1" agentId="agent-1" />);
    expect(queryByTestId("prompt-cache-pill")).toBeNull();
  });

  it("renders cache expiration when keep-alive is disabled", () => {
    const now = Date.now();
    setupSession({
      id: "agent-1",
      provider: "claude",
      labels: {},
      lastResponseAt: new Date(now),
      features: [{ type: "toggle", id: "cache_warm", label: "Cache warm-up", value: false }],
    });

    const { getByTestId, getByText } = render(
      <PromptCachePill serverId="server-1" agentId="agent-1" />,
    );
    expect(getByTestId("prompt-cache-pill")).not.toBeNull();
    expect(getByText("cache · in 60m")).not.toBeNull();
    expect(getByText("Turn on auto warm-up")).not.toBeNull();
  });

  it("renders next keep-alive tick when keep-alive is enabled and allows toggling", async () => {
    const now = Date.now();
    setupSession({
      id: "agent-1",
      provider: "claude",
      labels: {},
      lastResponseAt: new Date(now),
      features: [{ type: "toggle", id: "cache_warm", label: "Cache warm-up", value: true }],
    });

    const { getByTestId, getByText } = render(
      <PromptCachePill serverId="server-1" agentId="agent-1" />,
    );
    expect(getByTestId("prompt-cache-pill")).not.toBeNull();
    expect(getByText("warm · in 58m")).not.toBeNull();

    const button = getByTestId("prompt-cache-toggle-warmup-button");
    expect(button).not.toBeNull();
    expect(getByText("Turn off auto warm-up")).not.toBeNull();

    fireEvent.click(button);
    expect(setAgentFeatureMock).toHaveBeenCalledWith("agent-1", "cache_warm", false);
  });

  it("renders caching when active turn is in flight", () => {
    const now = Date.now();
    setupSession({
      id: "agent-1",
      provider: "claude",
      labels: {},
      lastResponseAt: new Date(now),
      status: "running",
      turn: {
        phase: "open",
        turnId: "turn-1",
        startedAt: new Date(now),
        cancellationRequestId: null,
      },
      features: [{ type: "toggle", id: "cache_warm", label: "Cache keep-alive", value: true }],
    });

    const { getByText } = render(<PromptCachePill serverId="server-1" agentId="agent-1" />);
    expect(getByText("caching")).not.toBeNull();
  });

  it("derives cache window label from resolved cacheWindowMs", () => {
    // Main session with 5m TTL override
    setupSession({
      id: "agent-main-5m",
      provider: "claude",
      labels: {},
      features: [
        { type: "select", id: "prompt_cache_ttl", label: "Cache window", value: "5m", options: [] },
      ],
    });
    const { getByText: getMainText } = render(
      <PromptCachePill serverId="server-1" agentId="agent-main-5m" />,
    );
    expect(getMainText("5 minutes")).not.toBeNull();
    cleanup();

    // Subagent with 1h TTL override
    setupSession({
      id: "agent-sub-1h",
      provider: "claude",
      labels: { [PARENT_AGENT_ID_LABEL]: "agent-parent" },
      features: [
        { type: "select", id: "prompt_cache_ttl", label: "Cache window", value: "1h", options: [] },
      ],
    });
    const { getByText: getSubText } = render(
      <PromptCachePill serverId="server-1" agentId="agent-sub-1h" />,
    );
    expect(getSubText("1 hour")).not.toBeNull();
  });

  it("renders capped segment and details when auto-cap is reached", () => {
    const now = Date.now();
    setupSession({
      id: "agent-capped",
      provider: "claude",
      labels: {},
      lastResponseAt: new Date(now),
      consecutiveWarmPings: 12,
      features: [{ type: "toggle", id: "cache_warm", label: "Cache warm-up", value: true }],
    });

    const { getByText } = render(<PromptCachePill serverId="server-1" agentId="agent-capped" />);
    expect(getByText("warm · capped")).not.toBeNull();
    expect(getByText("Capped (12/12 pings)")).not.toBeNull();
    expect(getByText("12 pings (11h36m)")).not.toBeNull();
  });
});
