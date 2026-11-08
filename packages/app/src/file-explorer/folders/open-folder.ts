import { useCallback } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { isSameFolder } from "./model";
import { useUpdateRecentFolders } from "./recent-folders";
import { filesWorkspaceKey, useFilesViewStore } from "./view-store";

/**
 * Shows a folder as the root of this workspace's Files panel and reveals Files. A folder other
 * than the workspace joins Recent, so it is one tap away on every device afterwards, unless the
 * caller already lists it elsewhere (`remember: false`, the Subagents group).
 */
export function useOpenFolderInFiles(serverId: string, workspaceId: string | null | undefined) {
  const isCompact = useIsCompactFormFactor();
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId ?? null);
  const updateRecent = useUpdateRecentFolders(serverId, workspaceId ?? "");
  return useCallback(
    (folder: string, options?: { remember?: boolean }) => {
      if (!workspaceId) return;
      const isWorkspace = Boolean(workspaceRoot && isSameFolder(folder, workspaceRoot));
      useFilesViewStore
        .getState()
        .setRoot(filesWorkspaceKey(serverId, workspaceId), isWorkspace ? null : folder);
      if (!isWorkspace && options?.remember !== false) void updateRecent("visit", folder);
      openExplorerSidebarView({
        isCompact,
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        view: "files",
      });
    },
    [isCompact, serverId, updateRecent, workspaceId, workspaceRoot],
  );
}
