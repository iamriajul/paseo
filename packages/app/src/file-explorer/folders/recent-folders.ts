import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type {
  WorkspaceRecentFolder,
  WorkspaceRecentFolderAction,
} from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";

const EMPTY_FOLDERS: WorkspaceRecentFolder[] = [];

export function recentFoldersQueryKey(serverId: string, workspaceId: string) {
  return ["workspaceRecentFolders", serverId, workspaceId] as const;
}

/** The host advertises recent folders, thumbnails, and the read-only refusal together. */
export function useFilesFolderSwitcherAvailable(serverId: string): boolean {
  // COMPAT(filesFolderSwitcher): added in v0.15.906 (fork), drop the gate after 2027-05-01.
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.filesFolderSwitcher === true,
  );
}

/**
 * The workspace's Recent group, kept on the daemon so every device shows the same list. Read
 * when the switcher mounts and refreshed when it opens; there is no push.
 */
export function useRecentFolders(serverId: string, workspaceId: string) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const available = useFilesFolderSwitcherAvailable(serverId);
  const query = useFetchQuery({
    queryKey: recentFoldersQueryKey(serverId, workspaceId),
    queryFn: () => client!.getWorkspaceRecentFolders(workspaceId),
    enabled: Boolean(client && available && workspaceId),
    dataShape: "list",
    staleTimeMs: 10_000,
  });
  return { folders: query.data ?? EMPTY_FOLDERS, refetch: query.refetch };
}

export function useUpdateRecentFolders(serverId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    async (action: WorkspaceRecentFolderAction, path: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      // COMPAT(filesFolderSwitcher): added in v0.15.906 (fork), drop the gate after 2027-05-01.
      if (!session?.client || session.serverInfo?.features?.filesFolderSwitcher !== true) return;
      try {
        const folders = await session.client.updateWorkspaceRecentFolders({
          workspaceId,
          action,
          path,
        });
        queryClient.setQueryData(recentFoldersQueryKey(serverId, workspaceId), folders);
      } catch (error) {
        // A viewer without write access browses fine; only the shared list stays unchanged.
        console.warn("[files] recent folders update failed", error);
      }
    },
    [queryClient, serverId, workspaceId],
  );
}
