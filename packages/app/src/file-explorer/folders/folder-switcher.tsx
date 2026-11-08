import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderSearch,
  Lock,
  Pin,
  SquareTerminal,
  X,
} from "lucide-react-native";
import { useStoreWithEqualityFn } from "zustand/traditional";
import equal from "fast-deep-equal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { shortenPath } from "@/utils/shorten-path";
import { folderName, isSameFolder, selectSubagentFolders, type SubagentFolder } from "./model";
import { useRecentFolders, useUpdateRecentFolders } from "./recent-folders";

const ThemedFolder = withUnistyles(Folder);
const ThemedTerminal = withUnistyles(SquareTerminal);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLock = withUnistyles(Lock);
const ThemedBot = withUnistyles(Bot);
const ThemedFolderSearch = withUnistyles(FolderSearch);
const ThemedPin = withUnistyles(Pin);
const ThemedX = withUnistyles(X);
const ThemedCheck = withUnistyles(Check);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });

const EMPTY_SUBAGENT_FOLDERS: SubagentFolder[] = [];
const WORKSPACE_ICON = <ThemedTerminal size={16} uniProps={accentColor} />;
const FOLDER_ICON = <ThemedFolder size={16} uniProps={mutedColor} />;
const AGENT_ICON = <ThemedBot size={16} uniProps={mutedColor} />;
const BROWSE_ICON = <ThemedFolderSearch size={16} uniProps={mutedColor} />;
const EXPANDED_ICON = <ThemedChevronDown size={16} uniProps={mutedColor} />;
const COLLAPSED_ICON = <ThemedChevronRight size={16} uniProps={mutedColor} />;

interface FolderSwitcherProps {
  serverId: string;
  workspaceId: string;
  workspaceRoot: string;
  /** The folder Files shows; the workspace root when it shows the workspace. */
  root: string;
  onSelectRoot: (folder: string, options?: { remember?: boolean }) => void;
}

/**
 * The top of Files: which folder it shows, and the other folders it can show. The workspace is
 * always first. Folders outside it are read-only.
 */
export function FolderSwitcher({
  serverId,
  workspaceId,
  workspaceRoot,
  root,
  onSelectRoot,
}: FolderSwitcherProps) {
  const { t } = useTranslation();
  const [subagentsExpanded, setSubagentsExpanded] = useState(false);
  const { folders: recent, refetch } = useRecentFolders(serverId, workspaceId);
  const updateRecent = useUpdateRecentFolders(serverId, workspaceId);
  const subagentFolders = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const agents = state.sessions[serverId]?.agents;
      if (!agents) return EMPTY_SUBAGENT_FOLDERS;
      const folders = selectSubagentFolders({
        agents: agents.values(),
        workspaceId,
        workspaceRoot,
      });
      return folders.length === 0 ? EMPTY_SUBAGENT_FOLDERS : folders;
    },
    equal,
  );
  const isWorkspaceRoot = isSameFolder(root, workspaceRoot);
  const subagentCount = useMemo(
    () => <Text style={styles.count}>{subagentFolders.length}</Text>,
    [subagentFolders.length],
  );
  const recentFolders = useMemo(
    () => recent.filter((folder) => !isSameFolder(folder.path, workspaceRoot)),
    [recent, workspaceRoot],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) void refetch();
      else setSubagentsExpanded(false);
    },
    [refetch],
  );
  const selectWorkspace = useCallback(
    () => onSelectRoot(workspaceRoot),
    [onSelectRoot, workspaceRoot],
  );
  const toggleSubagents = useCallback(() => setSubagentsExpanded((value) => !value), []);
  const browse = useCallback(() => {
    useAddProjectFlowStore.getState().openFolderPicker(serverId, (path) => onSelectRoot(path));
  }, [onSelectRoot, serverId]);

  return (
    <DropdownMenu compactMode="sheet" onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityLabel={t("workspace.fileExplorer.folders.switch")}
        testID="files-folder-switcher"
      >
        <View style={styles.triggerIcon}>
          {isWorkspaceRoot ? (
            <ThemedTerminal size={14} uniProps={mutedColor} />
          ) : (
            <ThemedFolder size={14} uniProps={mutedColor} />
          )}
        </View>
        <Text style={styles.triggerLabel} numberOfLines={1} testID="files-folder-switcher-label">
          {folderName(root)}
        </Text>
        {isWorkspaceRoot ? null : (
          <View style={styles.readOnlyBadge} testID="files-folder-read-only">
            <ThemedLock size={10} uniProps={mutedColor} />
            <Text style={styles.readOnlyText}>{t("workspace.fileExplorer.folders.readOnly")}</Text>
          </View>
        )}
        <ThemedChevronDown size={12} uniProps={mutedColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        minWidth={260}
        maxWidth={360}
        sheetTitle={t("workspace.fileExplorer.folders.title")}
        testID="files-folder-switcher-menu"
      >
        <DropdownMenuLabel>{t("workspace.fileExplorer.folders.workspace")}</DropdownMenuLabel>
        <DropdownMenuItem
          leading={WORKSPACE_ICON}
          description={t("workspace.fileExplorer.folders.workspaceDescription")}
          selected={isWorkspaceRoot}
          onSelect={selectWorkspace}
          testID="files-folder-workspace"
        >
          {folderName(workspaceRoot)}
        </DropdownMenuItem>
        {recentFolders.length > 0 ? (
          <>
            <DropdownMenuLabel>{t("workspace.fileExplorer.folders.recent")}</DropdownMenuLabel>
            {recentFolders.map((folder, index) => (
              <RecentFolderItem
                key={folder.path}
                path={folder.path}
                pinned={folder.pinned}
                selected={isSameFolder(folder.path, root)}
                onSelect={onSelectRoot}
                onPin={updateRecent}
                testID={`files-folder-recent-${index}`}
              />
            ))}
          </>
        ) : null}
        {subagentFolders.length > 0 ? (
          <>
            <DropdownMenuItem
              leading={subagentsExpanded ? EXPANDED_ICON : COLLAPSED_ICON}
              trailing={subagentCount}
              closeOnSelect={false}
              active={subagentsExpanded}
              onSelect={toggleSubagents}
              testID="files-folder-subagents"
            >
              {t("workspace.fileExplorer.folders.subagents")}
            </DropdownMenuItem>
            {subagentsExpanded
              ? subagentFolders.map((folder, index) => (
                  <SubagentFolderItem
                    key={folder.cwd}
                    folder={folder}
                    selected={isSameFolder(folder.cwd, root)}
                    onSelect={onSelectRoot}
                    testID={`files-folder-subagent-${index}`}
                  />
                ))
              : null}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem leading={BROWSE_ICON} onSelect={browse} testID="files-folder-browse">
          {t("workspace.fileExplorer.folders.browse")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function triggerStyle({
  hovered,
  pressed,
  open,
}: {
  hovered: boolean;
  pressed: boolean;
  open: boolean;
}) {
  return [styles.trigger, (hovered || pressed || open) && styles.triggerActive];
}

function RecentFolderItem({
  path,
  pinned,
  selected,
  onSelect,
  onPin,
  testID,
}: {
  path: string;
  pinned: boolean;
  selected: boolean;
  onSelect: (path: string) => void;
  onPin: (action: "pin" | "unpin" | "remove", path: string) => Promise<void>;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(path), [onSelect, path]);
  const togglePin = useCallback(
    () => void onPin(pinned ? "unpin" : "pin", path),
    [onPin, path, pinned],
  );
  const remove = useCallback(() => void onPin("remove", path), [onPin, path]);
  const actions = useMemo(
    () => (
      <View style={styles.rowActions}>
        {/* Custom trailing content replaces the item's own check, so draw it here. */}
        {selected ? <ThemedCheck size={16} uniProps={mutedColor} /> : null}
        <ToolbarButton
          label={
            pinned
              ? t("workspace.fileExplorer.folders.unpin")
              : t("workspace.fileExplorer.folders.pin")
          }
          selected={pinned}
          onPress={togglePin}
          testID={`${testID}-pin`}
        >
          <ThemedPin size={14} uniProps={pinned ? accentColor : extraMutedColor} />
        </ToolbarButton>
        <ToolbarButton
          label={t("workspace.fileExplorer.folders.remove")}
          onPress={remove}
          testID={`${testID}-remove`}
        >
          <ThemedX size={14} uniProps={extraMutedColor} />
        </ToolbarButton>
      </View>
    ),
    [pinned, remove, selected, t, testID, togglePin],
  );
  return (
    <DropdownMenuItem
      leading={FOLDER_ICON}
      description={shortenPath(path)}
      selected={selected}
      onSelect={handleSelect}
      testID={testID}
      trailing={actions}
    >
      {folderName(path)}
    </DropdownMenuItem>
  );
}

function SubagentFolderItem({
  folder,
  selected,
  onSelect,
  testID,
}: {
  folder: SubagentFolder;
  selected: boolean;
  onSelect: (path: string, options: { remember: boolean }) => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(
    () => onSelect(folder.cwd, { remember: false }),
    [folder.cwd, onSelect],
  );
  return (
    <DropdownMenuItem
      leading={AGENT_ICON}
      description={shortenPath(folder.cwd)}
      selected={selected}
      onSelect={handleSelect}
      testID={testID}
    >
      {folder.title?.trim() || t("workspace.fileExplorer.folders.untitledAgent")}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 32,
    marginHorizontal: theme.spacing[1.5],
    marginTop: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.base,
  },
  triggerActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  triggerIcon: {
    width: 16,
    alignItems: "center",
  },
  triggerLabel: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  readOnlyBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    flexShrink: 0,
  },
  readOnlyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  count: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
  },
}));
