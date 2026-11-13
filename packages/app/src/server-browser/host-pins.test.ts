import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { keepHostPinnedTabs } from "./host-pins";
import type { ServerBrowserTab } from "./store";

const SERVER = "server-1";
const WORKSPACE_KEY = `${SERVER}:ws-1`;

function hostTab(browserId: string, pinned: boolean): ServerBrowserTab {
  return {
    browserId,
    workspaceId: "ws-1",
    url: "http://localhost:4100/",
    title: "Page",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: { width: 1280, height: 800, mobile: false },
    openedBy: "user",
    createdAt: 0,
    suspended: true,
    ...(pinned ? { pinned: true } : {}),
  };
}

function layoutTabIds(): string[] {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  return layout ? collectAllTabs(layout.root).map((tab) => tab.tabId) : [];
}

describe("keepHostPinnedTabs", () => {
  it("reopens, pinned, a host-pinned tab this client's layout lost", () => {
    // A first tab list sent while the host was still restoring dropped the tab here.
    keepHostPinnedTabs(SERVER, [hostTab("pinned-tab", true), hostTab("plain-tab", false)]);

    expect(layoutTabIds()).toContain("server_browser_pinned-tab");
    expect(layoutTabIds()).not.toContain("server_browser_plain-tab");
    expect(useWorkspaceLayoutStore.getState().pinnedTabIdsByWorkspace[WORKSPACE_KEY]).toEqual(
      new Set(["server_browser_pinned-tab"]),
    );
  });

  it("drops the pin here once the host unpins the tab, and leaves the tab", () => {
    keepHostPinnedTabs(SERVER, [hostTab("pinned-tab", false)]);

    expect(layoutTabIds()).toContain("server_browser_pinned-tab");
    expect(
      useWorkspaceLayoutStore.getState().pinnedTabIdsByWorkspace[WORKSPACE_KEY],
    ).toBeUndefined();
  });
});
