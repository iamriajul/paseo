import { i18n as _i18n } from "@/i18n/i18next";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useWorkspaceAgentSettings,
  WorkspaceAgentSettingsModal,
  type UseWorkspaceAgentSettingsResult,
} from "./use-workspace-agent-settings";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import { AGENT_LABEL_RATE_LIMIT_AUTO_RESUME } from "@getpaseo/protocol/agent-labels";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { QueryClient } from "@tanstack/react-query";

const { theme, daemonConfigState } = vi.hoisted(() => ({
  daemonConfigState: {
    config: { autoResumeOnRateLimit: true } as unknown as MutableDaemonConfig,
  },
  theme: {
    spacing: { 1: 4, 3: 12, 4: 16 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    borderRadius: { md: 6 },
    colors: {
      surface0: "#000",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      palette: { amber: { 400: "#fbbf24", 500: "#f59e0b" } },
    },
    fontFamily: { ui: "sans-serif", mono: "monospace" },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: daemonConfigState.config,
  }),
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  const AdaptiveModalSheet = ({
    visible,
    children,
    onClose,
    testID,
  }: {
    visible: boolean;
    children: React.ReactNode;
    onClose: () => void;
    testID?: string;
  }) => {
    if (!visible) return null;
    return ReactModule.createElement(
      "div",
      { "data-testid": testID ?? "adaptive-modal-sheet" },
      ReactModule.createElement(
        "button",
        {
          type: "button",
          "data-testid": "adaptive-modal-sheet-close",
          onClick: onClose,
        },
        "Close",
      ),
      children,
    );
  };
  return { AdaptiveModalSheet };
});

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
      onValueChange?: (val: boolean) => void;
      disabled?: boolean;
      testID?: string;
    }) =>
      ReactModule.createElement("input", {
        type: "checkbox",
        checked: value,
        disabled: Boolean(disabled),
        "data-testid": testID,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => onValueChange?.(e.target.checked),
      }),
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

let root: Root | null = null;
let container: HTMLElement | null = null;

const modalTestSettings = { agentId: "agent-abc", currentTitle: "My Worker" };
const mockQueryClient = { invalidateQueries: vi.fn() } as unknown as QueryClient;
const mockUpdateAgent = vi.fn().mockResolvedValue(undefined);
const mockClient = { updateAgent: mockUpdateAgent } as unknown as DaemonClient;
const noopClose = () => undefined;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  daemonConfigState.config = { autoResumeOnRateLimit: true } as unknown as MutableDaemonConfig;
});

afterEach(async () => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  // React schedules passive work on setImmediate; let it run while the jsdom window still exists.
  await new Promise((resolve) => setImmediate(resolve));
  vi.unstubAllGlobals();
});

describe("useWorkspaceAgentSettings & WorkspaceAgentSettingsModal", () => {
  it("opens settings for agent tab and renders agent info", () => {
    const hookResultRef: { current: UseWorkspaceAgentSettingsResult | null } = { current: null };

    function TestComponent() {
      hookResultRef.current = useWorkspaceAgentSettings({ normalizedServerId: "local" });
      return null;
    }

    act(() => {
      root?.render(<TestComponent />);
    });

    expect(hookResultRef.current?.activeAgentSettings).toBeNull();

    act(() => {
      hookResultRef.current?.handleOpenAgentSettings({
        key: "agent_1",
        tabId: "agent_1",
        kind: "agent",
        target: { kind: "agent", agentId: "agent-123" },
      });
    });

    expect(hookResultRef.current?.activeAgentSettings).toEqual({
      agentId: "agent-123",
      currentTitle: "agent-1",
    });

    act(() => {
      hookResultRef.current?.handleCloseAgentSettings();
    });

    expect(hookResultRef.current?.activeAgentSettings).toBeNull();
  });

  it("toggles auto-resume on rate limits and updates agent labels via client", async () => {
    mockUpdateAgent.mockClear();
    const testAgent = {
      id: "agent-abc",
      title: "My Worker",
      labels: {},
    } as unknown as Agent;

    useSessionStore.setState({
      sessions: {
        local: {
          agents: new Map([["agent-abc", testAgent]]),
        } as unknown as SessionState,
      },
    });

    act(() => {
      root?.render(
        <WorkspaceAgentSettingsModal
          activeAgentSettings={modalTestSettings}
          client={mockClient}
          normalizedServerId="local"
          queryClient={mockQueryClient}
          onClose={noopClose}
        />,
      );
    });

    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="agent-settings-rate-limit-switch"]',
    );
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(false);

    // Toggle off
    act(() => {
      checkbox?.click();
    });

    expect(mockUpdateAgent).toHaveBeenCalledWith("agent-abc", {
      labels: {
        [AGENT_LABEL_RATE_LIMIT_AUTO_RESUME]: "false",
      },
    });
  });

  it("disables the toggle and renders global hint when autoResumeOnRateLimit is false", () => {
    daemonConfigState.config = { autoResumeOnRateLimit: false } as unknown as MutableDaemonConfig;

    const testAgent = {
      id: "agent-abc",
      title: "My Worker",
      labels: {},
    } as unknown as Agent;

    useSessionStore.setState({
      sessions: {
        local: {
          agents: new Map([["agent-abc", testAgent]]),
        } as unknown as SessionState,
      },
    });

    act(() => {
      root?.render(
        <WorkspaceAgentSettingsModal
          activeAgentSettings={modalTestSettings}
          client={null}
          normalizedServerId="local"
          queryClient={mockQueryClient}
          onClose={noopClose}
        />,
      );
    });

    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-testid="agent-settings-rate-limit-switch"]',
    );
    expect(checkbox).not.toBeNull();
    expect(checkbox?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Disabled globally in Host Settings");
  });
});
