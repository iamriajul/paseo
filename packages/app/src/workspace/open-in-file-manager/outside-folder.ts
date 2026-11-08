import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useOpenFolderInFiles } from "@/file-explorer/folders/open-folder";
import { useFilesFolderSwitcherAvailable } from "@/file-explorer/folders/recent-folders";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";

/**
 * Opens a folder outside the workspace. Hosts with the Files folder switcher show it in Files,
 * read-only, and add it to Recent. Older hosts can only list the workspace, so the folder goes
 * to the local file manager, or a toast where there is none.
 */
export function useOpenOutsideWorkspaceFolder(
  serverId: string,
  workspaceId: string | null | undefined,
): (folderPath: string) => void {
  const { t } = useTranslation();
  const toast = useToast();
  const isLocalExecution = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution });
  const fileManagerTarget = targets.find((target) => target.kind === "file-manager");
  const filesAvailable = useFilesFolderSwitcherAvailable(serverId) && Boolean(workspaceId);
  const openInFiles = useOpenFolderInFiles(serverId, workspaceId);

  return useCallback(
    (folderPath: string) => {
      if (filesAvailable) {
        openInFiles(folderPath);
        return;
      }
      const showOutsideWorkspace = () =>
        toast.show(t("common.errors.folderOutsideWorkspace", { path: folderPath }));
      if (!fileManagerTarget) {
        showOutsideWorkspace();
        return;
      }
      void openDesktopTarget({ editorId: fileManagerTarget.id, workspacePath: folderPath }).catch(
        (error: unknown) => {
          console.warn("[open-outside-workspace-folder] open failed", error);
          showOutsideWorkspace();
        },
      );
    },
    [fileManagerTarget, filesAvailable, openInFiles, t, toast],
  );
}
