import { useCallback, useMemo } from "react";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useDownloadStore } from "@/stores/download-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";

interface UseFileDownloadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

/**
 * Returns a stable callback that downloads a single workspace file by its
 * workspace-relative path. Shared by the file explorer tree and the git diff
 * pane so both surfaces download through the same download-store pipeline instead
 * of duplicating the plumbing: the HTTP token download over a direct TCP connection,
 * the session socket over anything else.
 */
export function useFileDownload({
  serverId,
  workspaceId,
  workspaceRoot,
}: UseFileDownloadParams): (input: { fileName: string; path: string }) => void {
  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceScopeId = useMemo(
    () => workspaceId?.trim() || normalizedWorkspaceRoot,
    [normalizedWorkspaceRoot, workspaceId],
  );
  const { requestFileDownloadToken, requestFileBytes } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const startDownload = useDownloadStore((state) => state.startDownload);
  // COMPAT(downloadStream): added in v0.15.911, drop gate after 2027-05-11.
  const streams = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.downloadStream === true,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  return useCallback(
    ({ fileName, path }) => {
      if (!workspaceScopeId) {
        return;
      }
      void startDownload({
        serverId,
        scopeId: workspaceScopeId,
        fileName,
        path,
        daemonProfile,
        activeConnectionId: getHostRuntimeStore().getSnapshot(serverId)?.activeConnectionId ?? null,
        requestFileDownloadToken: (targetPath) => requestFileDownloadToken(targetPath),
        openStream:
          streams && client
            ? (signal) =>
                client.openDownloadStream(
                  { cwd: normalizedWorkspaceRoot, path, kind: "file" },
                  { signal },
                )
            : null,
        readFile: requestFileBytes,
      });
    },
    [
      client,
      normalizedWorkspaceRoot,
      streams,
      daemonProfile,
      requestFileBytes,
      requestFileDownloadToken,
      serverId,
      startDownload,
      workspaceScopeId,
    ],
  );
}
