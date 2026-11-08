import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Grid2x2, Grid3x3, LayoutGrid, List, Scaling, Square } from "lucide-react-native";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import type { Theme } from "@/styles/theme";
import type { FilesGridSize, FilesViewMode } from "./model";

const ThemedList = withUnistyles(List);
const ThemedLayoutGrid = withUnistyles(LayoutGrid);
const ThemedScaling = withUnistyles(Scaling);
const ThemedGrid3x3 = withUnistyles(Grid3x3);
const ThemedGrid2x2 = withUnistyles(Grid2x2);
const ThemedSquare = withUnistyles(Square);
const extraMutedColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Shows the mode a press switches to, like the hidden-files toggle beside it. */
export function FilesViewModeButton({
  mode,
  compact,
  onChange,
}: {
  mode: FilesViewMode;
  compact: boolean;
  onChange: (mode: FilesViewMode) => void;
}) {
  const { t } = useTranslation();
  const next = mode === "grid" ? "list" : "grid";
  const handlePress = useCallback(() => onChange(next), [next, onChange]);
  const size = paneContentToolbarIconSize(compact);
  return (
    <ToolbarButton
      label={
        next === "grid"
          ? t("workspace.fileExplorer.grid.showGrid")
          : t("workspace.fileExplorer.grid.showList")
      }
      compact={compact}
      hitSlop={8}
      testID="files-view-mode"
      onPress={handlePress}
    >
      {next === "grid" ? (
        <ThemedLayoutGrid size={size} uniProps={extraMutedColor} />
      ) : (
        <ThemedList size={size} uniProps={extraMutedColor} />
      )}
    </ToolbarButton>
  );
}

const GRID_SIZES: { size: FilesGridSize; Icon: typeof ThemedGrid3x3 }[] = [
  { size: "small", Icon: ThemedGrid3x3 },
  { size: "medium", Icon: ThemedGrid2x2 },
  { size: "large", Icon: ThemedSquare },
];

/** One size for every folder's grid. */
export function FilesGridSizeMenu({
  size,
  compact,
  onChange,
}: {
  size: FilesGridSize;
  compact: boolean;
  onChange: (size: FilesGridSize) => void;
}) {
  const { t } = useTranslation();
  const labels: Record<FilesGridSize, string> = {
    small: t("workspace.fileExplorer.grid.small"),
    medium: t("workspace.fileExplorer.grid.medium"),
    large: t("workspace.fileExplorer.grid.large"),
  };
  return (
    <DropdownMenu compactMode="sheet">
      <ToolbarButton
        kind="menu"
        label={t("workspace.fileExplorer.grid.size")}
        compact={compact}
        hitSlop={8}
        testID="files-grid-size"
      >
        <ThemedScaling size={paneContentToolbarIconSize(compact)} uniProps={extraMutedColor} />
      </ToolbarButton>
      <DropdownMenuContent
        align="end"
        minWidth={160}
        sheetTitle={t("workspace.fileExplorer.grid.size")}
        testID="files-grid-size-menu"
      >
        {GRID_SIZES.map(({ size: option, Icon }) => (
          <GridSizeItem
            key={option}
            size={option}
            Icon={Icon}
            label={labels[option]}
            selected={option === size}
            onChange={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GridSizeItem({
  size,
  Icon,
  label,
  selected,
  onChange,
}: {
  size: FilesGridSize;
  Icon: typeof ThemedGrid3x3;
  label: string;
  selected: boolean;
  onChange: (size: FilesGridSize) => void;
}) {
  const handleSelect = useCallback(() => onChange(size), [onChange, size]);
  const leading = useMemo(() => <Icon size={16} uniProps={mutedColor} />, [Icon]);
  return (
    <DropdownMenuItem
      leading={leading}
      selected={selected}
      onSelect={handleSelect}
      testID={`files-grid-size-${size}`}
    >
      {label}
    </DropdownMenuItem>
  );
}
