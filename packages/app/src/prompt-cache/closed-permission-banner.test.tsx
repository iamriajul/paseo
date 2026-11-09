import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildClosedPermissionGoAheadPrompt } from "@getpaseo/protocol/agent-cache-warm";
import { ClosedPermissionBanner } from "./closed-permission-banner";

const { theme, runtimeState } = vi.hoisted(() => ({
  runtimeState: {
    client: {
      sendAgentMessage: vi.fn().mockResolvedValue({}),
    } as unknown as DaemonClient,
    isConnected: true,
  },
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { code: 12, sm: 12, base: 14 },
    fontWeight: { semibold: "600" },
    fontFamily: { mono: "monospace" },
    borderRadius: { md: 6, xl: 12, full: 9999 },
    borderWidth: { 1: 1 },
    colors: {
      surface1: "#111",
      foreground: "#fff",
      foregroundMuted: "#aaa",
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
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      ReactModule.createElement("div", { "data-testid": testID }, children),
    Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      ReactModule.createElement("span", { "data-testid": testID }, children),
  };
});

vi.mock("lucide-react-native", async () => {
  const ReactModule = await import("react");
  return {
    Play: () => ReactModule.createElement("svg"),
    ShieldOff: () => ReactModule.createElement("svg"),
  };
});

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ sessions: {} }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtimeState.client,
  useHostRuntimeIsConnected: () => runtimeState.isConnected,
}));

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

const CLOSED = { at: "2026-11-09T08:00:00.000Z", tool: "Bash", command: "npm publish --tag beta" };

describe("ClosedPermissionBanner", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("names the command and sends the agent the go-ahead on Run it now", async () => {
    act(() => {
      root.render(<ClosedPermissionBanner serverId="server-1" agentId="agent-1" closed={CLOSED} />);
    });
    expect(container.textContent).toContain("Permission closed while you were away");
    expect(container.querySelector('[data-testid="closed-permission-command"]')?.textContent).toBe(
      "Bash: npm publish --tag beta",
    );

    const run = container.querySelector<HTMLButtonElement>(
      '[data-testid="closed-permission-run-now"]',
    );
    await act(async () => run?.click());
    expect(runtimeState.client.sendAgentMessage).toHaveBeenCalledWith(
      "agent-1",
      buildClosedPermissionGoAheadPrompt(CLOSED),
    );
    expect(buildClosedPermissionGoAheadPrompt(CLOSED)).toContain("npm publish --tag beta");
  });

  it("offers no button in a read-only view", () => {
    act(() => {
      root.render(
        <ClosedPermissionBanner serverId="server-1" agentId="agent-1" closed={CLOSED} readOnly />,
      );
    });
    expect(container.querySelector('[data-testid="closed-permission-run-now"]')).toBeNull();
  });
});
