import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitCooldownPill } from "./rate-limit-cooldown-pill";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentRateLimitCooldownPayload } from "@getpaseo/protocol/messages";

const { theme, runtimeState, mockCooldown, mockCooldownWithAttempt } = vi.hoisted(() => ({
  runtimeState: {
    client: {
      resumeRateLimitCooldown: vi.fn().mockResolvedValue(undefined),
      cancelRateLimitCooldown: vi.fn().mockResolvedValue(undefined),
    } as unknown as DaemonClient,
    isConnected: true,
    supportsControls: true,
  },
  mockCooldown: {
    scheduledFor: "2026-10-20T02:00:00.000Z",
    retryAfter: "2026-10-20T02:00:00.000Z",
  } satisfies AgentRateLimitCooldownPayload,
  mockCooldownWithAttempt: {
    scheduledFor: "2026-10-20T02:00:00.000Z",
    retryAfter: "2026-10-20T02:00:00.000Z",
    consecutiveResumes: 2,
  } satisfies AgentRateLimitCooldownPayload,
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { xs: 11, sm: 12, base: 14 },
    fontWeight: { semibold: "600" },
    borderRadius: { md: 6, xl: 12, full: 9999 },
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
      statusWarningTint: "#c0966420",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (Component: React.ComponentType<{ size?: number; color?: string }>) =>
    function Wrapped(props: { size?: number; color?: string }) {
      return <Component {...props} />;
    },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", async () => {
  const ReactModule = await import("react");
  return {
    CalendarClock: (props: Record<string, unknown>) =>
      ReactModule.createElement("svg", { "data-testid": "icon-clock", ...props }),
    Play: (props: Record<string, unknown>) =>
      ReactModule.createElement("svg", { "data-testid": "icon-play", ...props }),
    XCircle: (props: Record<string, unknown>) =>
      ReactModule.createElement("svg", { "data-testid": "icon-x", ...props }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "rateLimitCooldown.title") return "Rate limit cooldown active";
      if (key === "rateLimitCooldown.resumeNow") return "Resume now";
      if (key === "rateLimitCooldown.cancel") return "Cancel auto-resume";
      if (key === "rateLimitCooldown.pillLabel") return `Cooldown · ${String(opts?.countdown)}`;
      if (key === "rateLimitCooldown.resumesAt")
        return `Scheduled to auto-resume at ${String(opts?.time)}`;
      return key;
    },
  }),
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    View: ({ children, testID, ...rest }: { children?: React.ReactNode; testID?: string }) =>
      ReactModule.createElement("div", { "data-testid": testID, ...rest }, children),
    Text: ({ children, testID, ...rest }: { children?: React.ReactNode; testID?: string }) =>
      ReactModule.createElement("span", { "data-testid": testID, ...rest }, children),
    Pressable: ({
      children,
      testID,
      onPress,
      ...rest
    }: {
      children?: React.ReactNode;
      testID?: string;
      onPress?: () => void;
    }) =>
      ReactModule.createElement(
        "button",
        { type: "button", "data-testid": testID, onClick: onPress, ...rest },
        children,
      ),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
  };
});

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      sessions: {
        "server-1": {
          serverInfo: {
            features: {
              rateLimitCooldownControls: runtimeState.supportsControls,
            },
          },
        },
      },
    }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtimeState.client,
  useHostRuntimeIsConnected: () => runtimeState.isConnected,
}));

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

describe("RateLimitCooldownPill", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T01:50:00.000Z"));

    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);

    runtimeState.supportsControls = true;
    container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders pill with countdown and actions", () => {
    act(() => {
      root.render(
        <RateLimitCooldownPill
          serverId="server-1"
          agentId="agent-1"
          cooldown={mockCooldownWithAttempt}
        />,
      );
    });

    const pill = container.querySelector('[data-testid="rate-limit-cooldown-pill"]');
    expect(pill).not.toBeNull();
    expect(container.textContent).toContain("Cooldown · 10m");
    expect(container.textContent).toContain("02:00:00 UTC");

    const resumeBtn = container.querySelector('[data-testid="rate-limit-pill-resume-button"]');
    expect(resumeBtn).not.toBeNull();

    const cancelBtn = container.querySelector('[data-testid="rate-limit-pill-cancel-button"]');
    expect(cancelBtn).not.toBeNull();
  });

  it("triggers resumeRateLimitCooldown on pill action", async () => {
    act(() => {
      root.render(
        <RateLimitCooldownPill serverId="server-1" agentId="agent-1" cooldown={mockCooldown} />,
      );
    });

    const resumeBtn = container.querySelector('[data-testid="rate-limit-pill-resume-button"]');
    await act(async () => {
      resumeBtn?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(runtimeState.client.resumeRateLimitCooldown).toHaveBeenCalledWith("agent-1");
  });

  it("triggers cancelRateLimitCooldown on cancel action", async () => {
    act(() => {
      root.render(
        <RateLimitCooldownPill serverId="server-1" agentId="agent-1" cooldown={mockCooldown} />,
      );
    });

    const cancelBtn = container.querySelector('[data-testid="rate-limit-pill-cancel-button"]');
    await act(async () => {
      cancelBtn?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(runtimeState.client.cancelRateLimitCooldown).toHaveBeenCalledWith("agent-1");
  });
  it("hides action buttons when rateLimitCooldownControls is false", () => {
    runtimeState.supportsControls = false;
    act(() => {
      root.render(
        <RateLimitCooldownPill serverId="server-1" agentId="agent-1" cooldown={mockCooldown} />,
      );
    });

    const resumeBtn = container.querySelector('[data-testid="rate-limit-pill-resume-button"]');
    expect(resumeBtn).toBeNull();

    const cancelBtn = container.querySelector('[data-testid="rate-limit-pill-cancel-button"]');
    expect(cancelBtn).toBeNull();
  });
});
