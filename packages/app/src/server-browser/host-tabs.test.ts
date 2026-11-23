import { beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  openHostTab,
  reconcileHostTabs,
  resetHostTabsForTests,
  trackHostTabClose,
} from "./host-tabs";
import { useServerBrowserStore, type ServerBrowserTab } from "./store";

const SERVER = "server-1";
const WORKSPACE_KEY = `${SERVER}:ws-1`;

function hostTab(browserId: string, extra: Partial<ServerBrowserTab> = {}): ServerBrowserTab {
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
    ...extra,
  };
}

/** The host sends a tab list, as useServerBrowserSync applies it. */
function hostSends(tabs: ServerBrowserTab[], snapshot = false): void {
  useServerBrowserStore.getState().setHost(SERVER, { tabs, status: { enabled: true } });
  reconcileHostTabs(SERVER, tabs, { snapshot, keepsPins: true });
}

function serverTabs(): Array<{ tabId: string; browserId: string }> {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  if (!layout) return [];
  return collectAllTabs(layout.root).flatMap((tab) =>
    tab.target.kind === "server_browser"
      ? [{ tabId: tab.tabId, browserId: tab.target.browserId }]
      : [],
  );
}

function browserIds(): string[] {
  return serverTabs().map((tab) => tab.browserId);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetHostTabsForTests();
  useServerBrowserStore.getState().clearHost(SERVER);
  for (const tab of serverTabs()) {
    useWorkspaceLayoutStore.getState().setTabPinned(WORKSPACE_KEY, tab.tabId, false);
    useWorkspaceLayoutStore.getState().closeTab(WORKSPACE_KEY, tab.tabId);
  }
});

describe("reconcileHostTabs", () => {
  it("opens a tab another client opened, in the background", () => {
    hostSends([hostTab("theirs")], true);
    hostSends([hostTab("theirs"), hostTab("also-theirs")]);

    expect(browserIds()).toEqual(["theirs", "also-theirs"]);
  });

  it("closes a tab the host ended, whatever id this client gave it", () => {
    // This client opened the tab in front, which gives it a random id.
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "server_browser", browserId: "mine" },
      intent: "new",
    });
    hostSends([hostTab("mine", { pinned: true })], true);
    expect(useWorkspaceLayoutStore.getState().pinnedTabIdsByWorkspace[WORKSPACE_KEY]).toEqual(
      new Set(serverTabs().map((tab) => tab.tabId)),
    );

    hostSends([]);

    expect(browserIds()).toEqual([]);
  });

  it("drops, on a snapshot, a saved tab the host no longer has", () => {
    hostSends([hostTab("gone")], true);
    resetHostTabsForTests();

    hostSends([], true);

    expect(browserIds()).toEqual([]);
  });

  it("reopens, pinned, a host-pinned tab this client's layout lost", () => {
    hostSends([hostTab("pinned-tab", { pinned: true })], true);
    useWorkspaceLayoutStore.getState().setTabPinned(WORKSPACE_KEY, serverTabs()[0]!.tabId, false);
    useWorkspaceLayoutStore.getState().closeTab(WORKSPACE_KEY, serverTabs()[0]!.tabId);

    hostSends([hostTab("pinned-tab", { pinned: true })]);

    expect(browserIds()).toEqual(["pinned-tab"]);
    expect(useWorkspaceLayoutStore.getState().pinnedTabIdsByWorkspace[WORKSPACE_KEY]).toEqual(
      new Set([serverTabs()[0]!.tabId]),
    );
  });

  it("drops the pin here once the host unpins the tab, and keeps the tab", () => {
    hostSends([hostTab("pinned-tab", { pinned: true })], true);
    hostSends([hostTab("pinned-tab")]);

    expect(browserIds()).toEqual(["pinned-tab"]);
    expect(
      useWorkspaceLayoutStore.getState().pinnedTabIdsByWorkspace[WORKSPACE_KEY],
    ).toBeUndefined();
  });
});

describe("openHostTab", () => {
  it("leaves the new tab to the opener, then places tabs other clients opened meanwhile", async () => {
    hostSends([], true);
    const answer = deferred<string>();
    const place = vi.fn((target: { kind: "server_browser"; browserId: string }) => {
      useWorkspaceLayoutStore
        .getState()
        .openTab({ workspaceKey: WORKSPACE_KEY, target, intent: "new" });
    });
    const opened = openHostTab({
      client: { serverBrowserOpenTab: () => answer.promise },
      serverId: SERVER,
      workspaceId: "ws-1",
      url: "about:blank",
      place,
    });

    // The host lists the new tab, and one another client opened, before it answers.
    hostSends([hostTab("mine"), hostTab("theirs")]);
    expect(browserIds()).toEqual([]);

    answer.resolve("mine");
    await opened;

    expect(place).toHaveBeenCalledTimes(1);
    expect(browserIds().sort()).toEqual(["mine", "theirs"]);
  });
});

describe("trackHostTabClose", () => {
  it("keeps a tab this client is closing out until the host answers", async () => {
    hostSends([hostTab("closing")], true);
    const [tab] = serverTabs();
    const close = deferred<void>();
    trackHostTabClose(SERVER, "closing", close.promise);
    useWorkspaceLayoutStore.getState().closeTab(WORKSPACE_KEY, tab!.tabId);

    hostSends([hostTab("closing"), hostTab("other")]);
    expect(browserIds()).toEqual(["other"]);

    close.resolve();
    hostSends([hostTab("other")]);
    await Promise.resolve();
    expect(browserIds()).toEqual(["other"]);
  });

  it("brings the tab back when the host refuses the close", async () => {
    hostSends([hostTab("kept")], true);
    const [tab] = serverTabs();
    const close = deferred<void>();
    trackHostTabClose(SERVER, "kept", close.promise);
    useWorkspaceLayoutStore.getState().closeTab(WORKSPACE_KEY, tab!.tabId);
    expect(browserIds()).toEqual([]);

    close.reject(new Error("The user pinned this tab"));
    await vi.waitFor(() => expect(browserIds()).toEqual(["kept"]));
  });
});
