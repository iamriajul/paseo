import { useCallback } from "react";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { isTabPinned } from "@/workspace-tabs/pinned-tabs";

/** Read once, outside React (close handlers). */
export function isWorkspaceTabPinned(workspaceKey: string, tabId: string): boolean {
  return isTabPinned(
    useWorkspaceLayoutStore.getState().pinnedTabIdsByWorkspace,
    workspaceKey,
    tabId,
  );
}

export function useIsWorkspaceTabPinned(input: {
  serverId: string;
  workspaceId: string;
  tabId: string;
}): boolean {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  return useWorkspaceLayoutStore((state) =>
    workspaceKey ? isTabPinned(state.pinnedTabIdsByWorkspace, workspaceKey, input.tabId) : false,
  );
}

/**
 * Whether the tab can be pinned on this host. A server browser tab's pin lives on the host (its
 * idle close and agents' browser_close_tab run there), so it needs a host that keeps pins.
 */
export function useCanPinWorkspaceTab(serverId: string, target: WorkspaceTabTarget): boolean {
  const hostKeepsServerTabPins = useHostFeature(serverId, "serverBrowserTabPin");
  return target.kind !== "server_browser" || hostKeepsServerTabPins;
}

export type SetWorkspaceTabPinned = (
  tab: { tabId: string; target: WorkspaceTabTarget },
  pinned: boolean,
) => void;

/**
 * Pins or unpins a tab in this client's layout. A server browser tab is pinned on the host too,
 * so every client shows the pin and the host keeps the tab; its pin then follows the host's tab
 * list (`useServerBrowserSync`).
 */
export function useSetWorkspaceTabPinned(input: {
  serverId: string;
  workspaceId: string;
}): SetWorkspaceTabPinned {
  const { serverId, workspaceId } = input;
  return useCallback<SetWorkspaceTabPinned>(
    (tab, pinned) => {
      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (!workspaceKey) return;
      const store = useWorkspaceLayoutStore.getState();
      store.setTabPinned(workspaceKey, tab.tabId, pinned);
      if (tab.target.kind !== "server_browser") return;
      const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
      const { browserId } = tab.target;
      void client?.serverBrowserSetTabPinned(browserId, pinned).catch((error: unknown) => {
        console.warn("[WorkspaceTabs] Failed to pin the server browser tab on the host", {
          browserId,
          error,
        });
        useWorkspaceLayoutStore.getState().setTabPinned(workspaceKey, tab.tabId, !pinned);
      });
    },
    [serverId, workspaceId],
  );
}
