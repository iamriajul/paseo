import { useCallback, useContext } from "react";
import { useTranslation } from "react-i18next";
import { parseWorkspaceLink } from "@getpaseo/protocol/workspace-link";
import { ToastContext } from "@/contexts/toast-api-context";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { requestWorkspacePreview } from "./preview-request-store";
import { resolveWorkspaceLinkOpen, type WorkspaceLinkHostState } from "./resolve";

function readHostState(serverId: string): WorkspaceLinkHostState | null {
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) {
    return null;
  }
  return {
    connected: isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(serverId)),
    workspacesHydrated: session.hasHydratedWorkspaces,
    workspaces: session.workspaces,
  };
}

/**
 * Opens `paseo://h/<serverId>/workspace/<workspaceId>[/preview]` inside the app.
 * Returns false for any other URL so the caller's link handling runs.
 */
export function useWorkspaceLinkOpener(): (url: string) => boolean {
  const { t } = useTranslation();
  // Markdown also renders outside the app shell (plugin surfaces, tests); a link
  // still navigates there, it just has no toast to report a dead end.
  const toast = useContext(ToastContext);
  return useCallback(
    (url: string) => {
      const target = parseWorkspaceLink(url);
      if (!target) {
        return false;
      }
      const outcome = resolveWorkspaceLinkOpen(target, readHostState(target.serverId));
      switch (outcome.kind) {
        case "host-unavailable":
          toast?.error(t("workspaceLinks.hostUnavailable"));
          return true;
        case "workspace-missing":
          toast?.error(t("workspaceLinks.workspaceMissing"));
          return true;
        case "preview-missing":
          navigateToWorkspace({ serverId: outcome.serverId, workspaceId: outcome.workspaceId });
          toast?.error(t("workspaceLinks.previewMissing"));
          return true;
        case "navigate":
          if (outcome.preview === "open") {
            requestWorkspacePreview(outcome.serverId, outcome.workspaceId);
          }
          navigateToWorkspace({ serverId: outcome.serverId, workspaceId: outcome.workspaceId });
          return true;
      }
    },
    [t, toast],
  );
}
