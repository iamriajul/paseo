import { usePaneContext } from "@/panels/pane-context";
import { useEffect, useMemo, useState } from "react";
import type { PluginFile, PluginTab } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFileHandle, useFileHandleSnapshot, type FileHandleSnapshot } from "@/file-panels/file";
import type { FilePanelFileKind } from "@/file-panels/resolve";
import { FilePanelLoading } from "@/file-panels/loading";
import { FilePanelPicker, FilePanelView, useFilePanelChoice, type FilePanel } from "@/file-panels";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useSessionStore } from "@/stores/session-store";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { formatFileSize } from "@/utils/format-file-size";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { OutsideFileBar } from "@/file-explorer/folders/outside-file-bar";
import { useImageGallery } from "@/file-explorer/gallery/hooks";
import { ImageGalleryView } from "@/file-explorer/gallery/view";
import type { ImageGallery } from "@/file-explorer/gallery/model";

/**
 * The file tab: stats the file, picks its panel and mounts it. The panel reads, saves and shows
 * its own loading; the tab only knows the file exists, its kind, and whether the panel has
 * unsaved changes.
 */
export function FilePane({
  serverId,
  workspaceRoot,
  location,
  navigationRevision,
}: {
  serverId: string;
  workspaceRoot: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const { t } = useTranslation();
  const { workspaceId } = usePaneContext();
  const connected = useSessionStore((state) => Boolean(state.sessions[serverId]?.client));
  const root = workspaceRoot.trim();
  const path = location.path.trim();
  const target = useMemo(
    () => (path ? resolveFilePreviewReadTarget({ path, workspaceRoot: root }) : null),
    [path, root],
  );
  const absolutePath = useMemo(
    () => buildAbsoluteExplorerPath({ workspaceRoot: root, entryPath: path }),
    [path, root],
  );
  // A hidden tab or a backgrounded app stops observing; observing again reports what changed.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  const handle = useFileHandle({
    serverId,
    target,
    absolutePath,
    observing: isActive && isAppVisible,
  });
  const snapshot = useFileHandleSnapshot(handle);
  const targetKey = target ? `${target.cwd}:${target.path}` : null;
  // An image in a folder Files has listed pages through that folder's images.
  const gallery = useImageGallery({ serverId, workspaceId, workspaceRoot: root, filePath: path });
  const { panel, choice } = useFilePanelChoice({
    serverId,
    targetKey,
    path,
    fileKind: choiceFileKind(snapshot, gallery !== null),
    presentable: isActive,
    lineNavigation: location.lineStart ? navigationRevision : null,
  });
  const [modified, setModified] = useState(false);
  usePublishPanelInstanceAttributes({ modified, suspendPendingSave: handle?.holdWrites });
  const panelLocation = useMemo(
    () => ({
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
      path,
    }),
    [location.lineEnd, location.lineStart, path],
  );

  const outsideBar = (
    <OutsideFileBar
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={root}
      filePath={path}
    />
  );

  let body;
  if (connected && isGalleryImage(gallery, panel)) {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        {outsideBar}
        <FilePanelPicker choice={choice} />
        <ImageGalleryView
          serverId={serverId}
          workspaceRoot={root}
          gallery={gallery}
          version={snapshot.status === "ready" ? fileVersion(snapshot) : null}
        />
      </View>
    );
  }
  if (!connected && target) {
    body = <Text style={styles.errorText}>{t("workspace.terminal.hostDisconnected")}</Text>;
  } else if (!handle || snapshot.status === "loading") {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <FilePanelLoading />
      </View>
    );
  } else if (snapshot.status === "missing" || snapshot.status === "error") {
    body = (
      <>
        <Text style={styles.errorText}>
          {snapshot.status === "error" ? snapshot.error : t("panels.file.notFound")}
        </Text>
        <Button variant="outline" size="sm" onPress={handle.retry}>
          {t("common.actions.retry")}
        </Button>
      </>
    );
  } else if (!panel) {
    body = (
      <>
        <Text style={styles.mutedText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
        <Text style={styles.mutedText}>{formatFileSize(snapshot.size)}</Text>
      </>
    );
  } else {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        {outsideBar}
        <FilePanelPicker choice={choice} />
        <MountedFilePanel
          key={`${panel.id}:${targetKey}`}
          panel={panel}
          file={handle.file}
          params={panelLocation}
          revision={navigationRevision}
          onModifiedChange={setModified}
        />
      </View>
    );
  }
  return (
    <View style={styles.container} testID="workspace-file-pane">
      {outsideBar}
      <View style={styles.centerState}>{body}</View>
    </View>
  );
}

/** Before its stat lands, a gallery image is taken at its extension, so a page shows at once. */
function choiceFileKind(
  snapshot: FileHandleSnapshot,
  inGallery: boolean,
): FilePanelFileKind | null {
  if (snapshot.status === "ready") return snapshot.kind;
  return inGallery ? "image" : null;
}

/** The built-in image panel pages through the folder; a plugin panel chosen for images does not. */
function isGalleryImage(
  gallery: ImageGallery | null,
  panel: FilePanel | null,
): gallery is ImageGallery {
  return gallery !== null && panel?.id === "builtin:image";
}

function fileVersion(version: { revision?: string; size: number; modifiedAt: string }): string {
  return version.revision ?? `${version.size}:${version.modifiedAt}`;
}

/** One panel mount. Its tab reports unsaved changes until the panel unmounts. */
function MountedFilePanel({
  panel,
  file,
  params,
  revision,
  onModifiedChange,
}: {
  panel: FilePanel;
  file: PluginFile;
  params: { path: string; lineStart?: number; lineEnd?: number };
  revision: number;
  onModifiedChange: (modified: boolean) => void;
}) {
  const { state, setCurrentTabState } = usePaneContext();
  const tab = useMemo<PluginTab>(
    () => ({
      setModified: onModifiedChange,
      state,
      setState: setCurrentTabState,
    }),
    [onModifiedChange, state, setCurrentTabState],
  );
  useEffect(() => () => onModifiedChange(false), [onModifiedChange]);
  return <FilePanelView panel={panel} file={file} tab={tab} params={params} revision={revision} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
