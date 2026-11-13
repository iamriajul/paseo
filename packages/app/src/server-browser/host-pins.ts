import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { ServerBrowserTab } from "./store";

/**
 * A server tab's pin lives on the host, so every client's tab bar shows the host's. A pinned tab
 * this client's layout lacks (it closed here while the host still had it, or the host brought it
 * back after a restart) opens in the background: a tab nothing but its owner may close must stay
 * reachable from every client.
 */
export function keepHostPinnedTabs(serverId: string, tabs: readonly ServerBrowserTab[]): void {
  for (const tab of tabs) {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId,
      workspaceId: tab.workspaceId,
    });
    if (!workspaceKey) continue;
    const target = { kind: "server_browser", browserId: tab.browserId } as const;
    const tabId = buildDeterministicWorkspaceTabId(target);
    const store = useWorkspaceLayoutStore.getState();
    if (tab.pinned === true && !layoutHasTab(workspaceKey, tabId)) {
      store.openTab({ workspaceKey, target, intent: "background" });
    }
    store.setTabPinned(workspaceKey, tabId, tab.pinned === true);
  }
}

function layoutHasTab(workspaceKey: string, tabId: string): boolean {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  return layout ? collectAllTabs(layout.root).some((tab) => tab.tabId === tabId) : false;
}
