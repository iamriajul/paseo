import { Text, View } from "react-native";
import { Files } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { FolderSwitcher } from "@/file-explorer/folders/folder-switcher";
import { isSameFolder } from "@/file-explorer/folders/model";
import { useOpenFolderInFiles } from "@/file-explorer/folders/open-folder";
import { useFilesFolderSwitcherAvailable } from "@/file-explorer/folders/recent-folders";
import { filesWorkspaceKey, useFilesViewStore } from "@/file-explorer/folders/view-store";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";

const ThemedFiles = withUnistyles(Files);
const filesPanelPresentation = {
  label: (t) => t("panels.files.label"),
  subtitle: (t) => t("panels.files.subtitle"),
  tooltip: (t) => t("panels.files.tooltip"),
  icon: ThemedFiles,
} satisfies PanelPresentation;

function FilesPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, openPreferredTarget, openTargetToSide } = usePaneContext();
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  const switcherAvailable = useFilesFolderSwitcherAvailable(serverId);
  const storedRoot = useFilesViewStore(
    (state) => state.rootByWorkspace[filesWorkspaceKey(serverId, workspaceId)] ?? null,
  );
  const openFolder = useOpenFolderInFiles(serverId, workspaceId);
  invariant(target.kind === "files", "FilesPanel requires files target");
  // A host without the switcher only ever shows its workspace.
  const root = (switcherAvailable && storedRoot) || workspaceRoot;
  const isOutside = Boolean(root && workspaceRoot && !isSameFolder(root, workspaceRoot));
  // Entry paths are relative to the root; a file outside the workspace opens by absolute path.
  const toTargetPath = useCallback(
    (path: string) =>
      isOutside && root
        ? buildAbsoluteExplorerPath({ workspaceRoot: root, entryPath: path })
        : path,
    [isOutside, root],
  );
  const onOpenFile = useCallback(
    (path: string) =>
      openPreferredTarget({ kind: "file", path: toTargetPath(path) }, "explorerFiles"),
    [openPreferredTarget, toTargetPath],
  );
  const onOpenFileToSide = useCallback(
    (path: string) => openTargetToSide?.({ kind: "file", path: toTargetPath(path) }),
    [openTargetToSide, toTargetPath],
  );
  if (!workspaceRoot || !root) {
    return (
      <View style={styles.centerState}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      {switcherAvailable ? (
        <FolderSwitcher
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={workspaceRoot}
          root={root}
          onSelectRoot={openFolder}
        />
      ) : null}
      <FileExplorerPane
        // Each root keeps its own listing, expansion, and selection.
        key={root}
        serverId={serverId}
        workspaceId={isOutside ? null : workspaceId}
        workspaceRoot={root}
        readOnly={isOutside}
        onOpenFile={onOpenFile}
        onOpenFileToSide={openTargetToSide ? onOpenFileToSide : undefined}
        onAddToChat={canAddToChat && !isOutside ? addFile : undefined}
      />
    </View>
  );
}

export const filesPanelRegistration = definePanel("files", {
  component: FilesPanel,
  presentation: filesPanelPresentation,
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
}));
