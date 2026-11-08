import { useCallback, useMemo, useState, type ReactElement } from "react";
import {
  FlatList,
  Image,
  Text,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, Folder } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { ExplorerEntry } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { FILES_GRID_TILE_EDGE, isThumbnailImage, type FilesGridSize } from "./model";
import { useFileThumbnail } from "./thumbnails";

const TILE_GAP = 8;
const GRID_PADDING = 12;

const ThemedFolder = withUnistyles(Folder);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface FilesGridProps {
  serverId: string;
  /** The browse root the entry paths are relative to. */
  root: string;
  /** The folder shown, relative to the root. */
  path: string;
  entries: readonly ExplorerEntry[];
  size: FilesGridSize;
  selectedEntryPath: string | null;
  onOpenEntry: (entry: ExplorerEntry) => void;
  onSelectEntry: (entry: ExplorerEntry) => void;
  onNavigateUp: () => void;
  renderEntryMenu: (entry: ExplorerEntry) => ReactElement;
}

/**
 * One folder at a time as tiles: images as daemon-made thumbnails, everything else as its
 * file-type icon. A folder tile opens that folder in the grid; a file opens its preview.
 */
export function FilesGrid({
  serverId,
  root,
  path,
  entries,
  size,
  selectedEntryPath,
  onOpenEntry,
  onSelectEntry,
  onNavigateUp,
  renderEntryMenu,
}: FilesGridProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const tileEdge = FILES_GRID_TILE_EDGE[size];
  const columns = Math.max(
    1,
    Math.floor((width - GRID_PADDING * 2 + TILE_GAP) / (tileEdge + TILE_GAP)),
  );
  // Tiles stretch to fill the row, so the grid never leaves a ragged gap on the right.
  const tileWidth =
    width > 0 ? (width - GRID_PADDING * 2 - TILE_GAP * (columns - 1)) / columns : tileEdge;
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const renderTile = useCallback(
    ({ item, index }: ListRenderItemInfo<ExplorerEntry>) => (
      <View
        style={[styles.tileSlot, { width: tileWidth }, index % columns !== 0 && styles.tileGap]}
      >
        <ContextMenu>
          <GridTile
            serverId={serverId}
            root={root}
            entry={item}
            tileWidth={tileWidth}
            selected={selectedEntryPath === item.path}
            onOpen={onOpenEntry}
            onSelect={onSelectEntry}
            testID={`files-grid-tile-${index}`}
          />
          {renderEntryMenu(item)}
        </ContextMenu>
      </View>
    ),
    [
      columns,
      onOpenEntry,
      onSelectEntry,
      renderEntryMenu,
      root,
      selectedEntryPath,
      serverId,
      tileWidth,
    ],
  );

  const header = useMemo(
    () =>
      path === "." ? null : (
        <PressHighlight
          onPress={onNavigateUp}
          style={upRowStyle}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.fileExplorer.grid.up")}
          testID="files-grid-up"
        >
          <ThemedChevronLeft size={14} uniProps={mutedColor} />
          <Text style={styles.upLabel} numberOfLines={1}>
            {path}
          </Text>
        </PressHighlight>
      ),
    [onNavigateUp, path, t],
  );

  return (
    <View style={styles.container} onLayout={handleLayout} testID="files-grid">
      {width > 0 ? (
        <FlatList
          key={`columns-${columns}`}
          data={entries}
          numColumns={columns}
          renderItem={renderTile}
          keyExtractor={tileKey}
          ListHeaderComponent={header}
          contentContainerStyle={styles.content}
          initialNumToRender={24}
          windowSize={7}
        />
      ) : null}
    </View>
  );
}

function tileKey(entry: ExplorerEntry): string {
  return entry.path;
}

function upRowStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.upRow, (Boolean(hovered) || pressed) && styles.upRowActive];
}

function GridTile({
  serverId,
  root,
  entry,
  tileWidth,
  selected,
  onOpen,
  onSelect,
  testID,
}: {
  serverId: string;
  root: string;
  entry: ExplorerEntry;
  tileWidth: number;
  selected: boolean;
  onOpen: (entry: ExplorerEntry) => void;
  onSelect: (entry: ExplorerEntry) => void;
  testID: string;
}) {
  const isImage = entry.kind === "file" && isThumbnailImage(entry.name);
  const thumbnail = useFileThumbnail({
    serverId,
    root,
    path: entry.path,
    modifiedAt: entry.modifiedAt,
    tileEdge: tileWidth,
    enabled: isImage,
  });
  const handlePress = useCallback(() => onOpen(entry), [entry, onOpen]);
  const handleSelect = useCallback(() => onSelect(entry), [entry, onSelect]);
  const tileStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.tile,
      (Boolean(hovered) || pressed || selected) && styles.tileActive,
    ],
    [selected],
  );
  const iconSize = Math.round(Math.min(48, tileWidth * 0.36));
  const previewStyle = useMemo(() => [styles.preview, { height: tileWidth }], [tileWidth]);
  const source = useMemo(() => (thumbnail ? { uri: thumbnail } : null), [thumbnail]);
  let preview;
  if (source) {
    preview = (
      <Image
        source={source}
        style={styles.thumbnail}
        resizeMode="contain"
        testID={`${testID}-thumbnail`}
      />
    );
  } else if (entry.kind === "directory") {
    preview = <ThemedFolder size={iconSize} uniProps={mutedColor} />;
  } else {
    preview = <MaterialFileIcon fileName={entry.name} size={iconSize} />;
  }

  return (
    <ContextMenuTrigger
      onPress={handlePress}
      onLongPress={handleSelect}
      onContextMenu={handleSelect}
      style={tileStyle}
      accessibilityLabel={entry.name}
      testID={testID}
    >
      <View style={previewStyle}>{preview}</View>
      <Text style={styles.name} numberOfLines={1} testID={`${testID}-name`}>
        {entry.name}
      </Text>
    </ContextMenuTrigger>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  content: {
    padding: GRID_PADDING,
    paddingTop: theme.spacing[2],
    gap: TILE_GAP,
  },
  tileSlot: {
    flexShrink: 0,
  },
  tileGap: {
    marginLeft: TILE_GAP,
  },
  tile: {
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[1],
    gap: theme.spacing[1],
  },
  tileActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  preview: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  thumbnail: {
    width: "100%",
    height: "100%",
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    userSelect: "none",
  },
  upRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: 28,
    paddingHorizontal: theme.spacing[1],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  upRowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  upLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));
