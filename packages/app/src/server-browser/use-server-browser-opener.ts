import { useCallback } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { isServerBrowserEnabled } from "./store";

/**
 * While the host's server browser is on, URLs the workspace would open in its Browser (service
 * links, localhost links, the ports panel) open in a server browser tab instead: the page loads
 * on the host, so localhost is the host's, and every client sees the same tab.
 * Returns false when the server browser is off, so the caller falls through to its own Browser.
 */
export function useServerBrowserUrlOpener(params: {
  serverId: string;
  workspaceId: string;
  openFocused: (target: WorkspaceTabTarget) => void;
  onError?: (message: string) => void;
}): (url: string) => boolean {
  const { serverId, workspaceId, openFocused, onError } = params;
  const client = useHostRuntimeClient(serverId);
  return useCallback(
    (url: string) => {
      if (!client || !workspaceId || !isServerBrowserEnabled(serverId)) return false;
      if (!/^https?:\/\//i.test(url)) return false;
      void client
        .serverBrowserOpenTab(workspaceId, url)
        .then((browserId) => openFocused({ kind: "server_browser", browserId }))
        .catch((error: unknown) =>
          onError?.(error instanceof Error ? error.message : String(error)),
        );
      return true;
    },
    [client, onError, openFocused, serverId, workspaceId],
  );
}
