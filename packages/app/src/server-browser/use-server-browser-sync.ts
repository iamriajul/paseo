import { useEffect } from "react";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { collectAllTabs, findPaneById } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useServerBrowserStore, type ServerBrowserTab } from "./store";

// Agent tabs and popups already placed in a workspace this app session. A tab the user closed
// is closed on the daemon too, so it never comes back; this only stops repeated opens per push.
const placedAgentTabs = new Set<string>();
// Tabs this app session has seen per host, so a tab the daemon closes (an agent's
// browser_close_tab, idle close, a crash) leaves the workspace instead of lingering as "closed".
const knownTabs = new Map<string, Map<string, string>>();

/**
 * Keeps one host's server browser tabs in the store, and opens each agent-created tab in its
 * workspace in the background, the same way the app opens tabs its own browser host creates.
 */
export function useServerBrowserSync(serverId: string): void {
  const supported = useHostFeature(serverId, "serverBrowser");
  const client = useHostRuntimeClient(serverId);

  useEffect(() => {
    if (!supported || !client) return;
    const subscription = client.observeServerBrowserTabs();
    const apply = (tabs: ServerBrowserTab[], status: { enabled: boolean }) => {
      useServerBrowserStore.getState().setHost(serverId, { tabs, status });
      placeAgentTabs(serverId, tabs);
      removeClosedTabs(serverId, tabs);
    };
    const unsubscribe = subscription.subscribe({
      snapshot: (snapshot) => {
        apply(snapshot.tabs, snapshot.status);
        removeStaleLayoutTabs(serverId, snapshot.tabs);
      },
      update: (message) => {
        if (message.type === "browser.server.tabs.update") {
          apply(message.payload.tabs, message.payload.status);
        }
      },
    });
    return () => {
      unsubscribe();
      void subscription.release().catch(() => {});
      useServerBrowserStore.getState().clearHost(serverId);
    };
  }, [client, serverId, supported]);
}

/**
 * Opens agents' tabs and pages a tab opened (popups) in their workspace. A popup opens next to its
 * opener, in front on the client whose focused tab is the opener (the one that clicked, as in a
 * browser) and in the background elsewhere; an agent's tab opens in the background.
 */
function placeAgentTabs(serverId: string, tabs: ServerBrowserTab[]): void {
  for (const tab of tabs) {
    const key = `${serverId}:${tab.browserId}`;
    if ((tab.openedBy !== "agent" && !tab.openerBrowserId) || placedAgentTabs.has(key)) continue;
    placedAgentTabs.add(key);
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId,
      workspaceId: tab.workspaceId,
    });
    if (!workspaceKey) continue;
    const store = useWorkspaceLayoutStore.getState();
    const opener = tab.openerBrowserId;
    store.openTab({
      workspaceKey,
      target: { kind: "server_browser", browserId: tab.browserId },
      intent:
        opener && isFocusedServerTab(store.layoutByWorkspace[workspaceKey], opener)
          ? "new"
          : "background",
      ...(opener
        ? {
            parentTabId: buildDeterministicWorkspaceTabId({
              kind: "server_browser",
              browserId: opener,
            }),
          }
        : {}),
    });
  }
}

function isFocusedServerTab(
  layout:
    | ReturnType<typeof useWorkspaceLayoutStore.getState>["layoutByWorkspace"][string]
    | undefined,
  browserId: string,
): boolean {
  if (!layout) return false;
  const pane = findPaneById(layout.root, layout.focusedPaneId);
  if (!pane?.focusedTabId || pane.hidden === true) return false;
  const focused = collectAllTabs(layout.root).find((tab) => tab.tabId === pane.focusedTabId);
  return focused?.target.kind === "server_browser" && focused.target.browserId === browserId;
}

function removeClosedTabs(serverId: string, tabs: ServerBrowserTab[]): void {
  const previous = knownTabs.get(serverId) ?? new Map<string, string>();
  const current = new Map(tabs.map((tab) => [tab.browserId, tab.workspaceId] as const));
  knownTabs.set(serverId, current);
  for (const [browserId, workspaceId] of previous) {
    if (current.has(browserId)) continue;
    const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    if (workspaceKey) {
      useWorkspaceLayoutStore
        .getState()
        .closeTab(
          workspaceKey,
          buildDeterministicWorkspaceTabId({ kind: "server_browser", browserId }),
        );
    }
  }
}

/**
 * A snapshot is the daemon's whole tab list, so a server tab still in a persisted layout but
 * missing from it closed while this client was away (daemon restart, idle close); drop it.
 */
function removeStaleLayoutTabs(serverId: string, tabs: ServerBrowserTab[]): void {
  const live = new Set(tabs.map((tab) => tab.browserId));
  const store = useWorkspaceLayoutStore.getState();
  for (const [workspaceKey, layout] of Object.entries(store.layoutByWorkspace)) {
    if (!workspaceKey.startsWith(`${serverId}:`)) continue;
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.target.kind === "server_browser" && !live.has(tab.target.browserId)) {
        store.closeTab(workspaceKey, tab.tabId);
      }
    }
  }
}
