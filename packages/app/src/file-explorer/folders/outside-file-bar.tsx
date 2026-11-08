import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { shortenPath } from "@/utils/shorten-path";
import { isPathInsideFolder, parentFolder } from "./model";
import { useOpenFolderInFiles } from "./open-folder";
import { useFilesFolderSwitcherAvailable } from "./recent-folders";

const ThemedFolder = withUnistyles(Folder);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Above the preview of a file outside the workspace: the folder it lives in, and a way to show
 * that folder in Files. Renders nothing for workspace files.
 */
export function OutsideFileBar({
  serverId,
  workspaceId,
  workspaceRoot,
  filePath,
}: {
  serverId: string;
  workspaceId: string | null;
  workspaceRoot: string;
  filePath: string;
}) {
  const { t } = useTranslation();
  const available = useFilesFolderSwitcherAvailable(serverId);
  const openFolder = useOpenFolderInFiles(serverId, workspaceId);
  const folder = parentFolder(filePath);
  const handlePress = useCallback(() => {
    if (folder) openFolder(folder);
  }, [folder, openFolder]);
  if (!available || !workspaceId || !folder || isPathInsideFolder(filePath, workspaceRoot)) {
    return null;
  }
  return (
    <View style={styles.bar} testID="file-outside-workspace-bar">
      <ThemedFolder size={14} uniProps={mutedColor} />
      <Text style={styles.path} numberOfLines={1}>
        {shortenPath(folder)}
      </Text>
      <Button variant="ghost" size="sm" onPress={handlePress} testID="file-show-in-folder">
        {t("workspace.fileExplorer.folders.showInFolder")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 36,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  path: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
