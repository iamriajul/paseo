import { createContext, useContext, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Download, FileDiff, Share } from "lucide-react-native";
import { DiffStat } from "@/components/diff-stat";
import {
  PaneContentToolbar,
  ToolbarButton,
  paneContentToolbarIconSize,
} from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { formatFileSize } from "@/utils/format-file-size";

const ThemedFileDiff = withUnistyles(FileDiff);
const ThemedDownload = withUnistyles(Download);
const ThemedShare = withUnistyles(Share);
const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** What the file has in Changes, and how to show it there. */
export interface FileTabChanges {
  additions: number;
  deletions: number;
  show(): void;
}

/**
 * The file tab's own actions, shown at the end of whichever toolbar heads the tab: the panel's
 * when it has one, otherwise the tab's (`FileTabToolbar`).
 */
export interface FileTabActions {
  /** Null when Changes does not list the file. */
  changes: FileTabChanges | null;
  /** Saves the file on web and desktop and shares it on iOS and Android; null when offline. */
  download: (() => void) | null;
}

const NO_ACTIONS: FileTabActions = { changes: null, download: null };
const FileTabActionsContext = createContext<FileTabActions>(NO_ACTIONS);

export const FileTabActionsProvider = FileTabActionsContext.Provider;

export function FileTabActionButtons() {
  const { t } = useTranslation();
  const { changes, download } = useContext(FileTabActionsContext);
  const isCompact = useIsCompactFormFactor();
  const iconSize = paneContentToolbarIconSize(isCompact);
  if (!changes && !download) return null;
  const DownloadIcon = isNative ? ThemedShare : ThemedDownload;
  return (
    <View style={styles.actions}>
      {changes ? (
        <ToolbarButton
          label={t("panels.file.actions.showChanges")}
          onPress={changes.show}
          style={styles.changes}
          testID="file-show-changes"
        >
          <ThemedFileDiff size={iconSize} uniProps={iconColor} />
          {changes.additions + changes.deletions > 0 ? (
            <DiffStat additions={changes.additions} deletions={changes.deletions} />
          ) : null}
        </ToolbarButton>
      ) : null}
      {download ? (
        <ToolbarButton
          label={isNative ? t("panels.file.actions.share") : t("panels.file.actions.download")}
          onPress={download}
          testID="file-download"
        >
          <DownloadIcon size={iconSize} uniProps={iconColor} />
        </ToolbarButton>
      ) : null}
    </View>
  );
}

/** The toolbar of a file tab whose panel has none: the file's size, then the tab's actions. */
export function FileTabToolbar({ size, children }: { size: number; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <PaneContentToolbar testID="file-tab-toolbar">
      <View style={styles.row}>
        <Text
          style={styles.size}
          numberOfLines={1}
          accessibilityLabel={t("panels.file.editor.fileSize", { size: formatFileSize(size) })}
        >
          {formatFileSize(size)}
        </Text>
        {children}
        <FileTabActionButtons />
      </View>
    </PaneContentToolbar>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  size: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  changes: {
    width: "auto",
    flexDirection: "row",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[1.5],
  },
}));
