import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import { startFolderDownload } from "@/stores/folder-download";

interface UseFolderDownloadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

export type DownloadFolder = (input: { path: string; name: string }) => void;

/**
 * Returns a callback that downloads a workspace folder as a zip, or `null` when the host's
 * daemon predates folder download. The zip holds what Files shows: hidden entries follow the
 * "show hidden files" toggle at the moment of the download.
 */
export function useFolderDownload({
  serverId,
  workspaceId,
  workspaceRoot,
}: UseFolderDownloadParams): DownloadFolder | null {
  const { t } = useTranslation();
  // COMPAT(downloadStream): added in v0.15.911, drop gate after 2027-05-11.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.downloadStream === true,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const cwd = workspaceRoot.trim();
  const scopeId = workspaceId?.trim() || cwd;

  const download = useCallback<DownloadFolder>(
    ({ path, name }) => {
      if (!cwd || !scopeId) return;
      const includeHidden = usePanelStore.getState().explorerShowHiddenFiles;
      const requireClient = () => {
        if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
        return client;
      };
      void startFolderDownload({
        serverId,
        scopeId,
        fileName: `${name}.zip`,
        daemonProfile,
        activeConnectionId: getHostRuntimeStore().getSnapshot(serverId)?.activeConnectionId ?? null,
        requestToken: async () => {
          const payload = await requireClient().requestFolderDownloadToken({
            cwd,
            path,
            includeHidden,
          });
          if (payload.error) throw new Error(payload.error);
          return payload;
        },
        openStream: (signal) =>
          requireClient().openDownloadStream(
            { cwd, path, kind: "folder", includeHidden },
            { signal },
          ),
      });
    },
    [client, cwd, daemonProfile, scopeId, serverId, t],
  );

  return supported ? download : null;
}
