import { useCallback, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Square } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { normalizeBackgroundTaskDisplayType, type BackgroundTaskDisplayType } from "./type-badge";
import { buildBackgroundTaskPillPresentation } from "./track-presentation";

const ThemedSquare = withUnistyles(Square);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export interface BackgroundTasksTrackProps {
  rows: BackgroundTaskDescriptorPayload[];
  onOpenTask: (taskId: string) => void;
  onStopTask: (taskId: string) => void;
  stoppingTaskIds?: ReadonlySet<string>;
}

const ROW_ICON_SIZE = 14;

function rowLabel(row: BackgroundTaskDescriptorPayload): string {
  const command = row.command?.trim();
  if (command) return command;
  const description = row.description.trim();
  return description.length > 0 ? description : row.taskId;
}

function statusLabel(
  status: BackgroundTaskDescriptorPayload["status"],
  t: (key: string) => string,
): string {
  switch (status) {
    case "running":
      return t("backgroundTasks.statusRunning");
    case "stopped":
      return t("backgroundTasks.statusStopped");
    case "failed":
      return t("backgroundTasks.statusFailed");
    case "completed":
      return t("backgroundTasks.statusCompleted");
    default:
      return t("backgroundTasks.statusUnknown");
  }
}

function typeBadgeLabel(
  displayType: BackgroundTaskDisplayType,
  t: (key: string) => string,
): string {
  switch (displayType) {
    case "shell":
      return t("backgroundTasks.typeShell");
    case "monitor":
      return t("backgroundTasks.typeMonitor");
    case "workflow":
      return t("backgroundTasks.typeWorkflow");
    case "other":
      return t("backgroundTasks.typeOther");
  }
}

export function BackgroundTasksTrack({
  rows,
  onOpenTask,
  onStopTask,
  stoppingTaskIds,
}: BackgroundTasksTrackProps): ReactElement | null {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return null;
  }

  const pill = buildBackgroundTaskPillPresentation(t, rows);

  return (
    <ComposerTrackPill
      testID="background-tasks-track-header"
      segments={pill.segments}
      accessibilityLabel={pill.accessibilityLabel}
      panelTitle={t("backgroundTasks.header")}
    >
      {rows.map((row) => (
        <BackgroundTasksTrackRow
          key={row.taskId}
          row={row}
          stopping={stoppingTaskIds?.has(row.taskId) === true}
          onOpenTask={onOpenTask}
          onStopTask={onStopTask}
        />
      ))}
    </ComposerTrackPill>
  );
}

function BackgroundTasksTrackRow({
  row,
  stopping,
  onOpenTask,
  onStopTask,
}: {
  row: BackgroundTaskDescriptorPayload;
  stopping: boolean;
  onOpenTask: (taskId: string) => void;
  onStopTask: (taskId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const label = rowLabel(row);
  const displayType = normalizeBackgroundTaskDisplayType(row.type);
  const typeLabel = typeBadgeLabel(displayType, t);
  const handlePress = useCallback(() => {
    onOpenTask(row.taskId);
  }, [onOpenTask, row.taskId]);
  const handleStopPress = useCallback(() => {
    onStopTask(row.taskId);
  }, [onStopTask, row.taskId]);
  const actionsAlwaysVisible = isNative || isCompact;
  const canStop = row.status === "running" || row.status === "unknown";

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <StatusBadge label={typeLabel} variant="muted" />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {label}
        </Text>
        {canStop ? (
          <BackgroundTaskStopButton
            label={label}
            taskId={row.taskId}
            visible={actionsAlwaysVisible || active}
            stopping={stopping}
            onPress={handleStopPress}
          />
        ) : null}
      </>
    ),
    [actionsAlwaysVisible, canStop, handleStopPress, label, row.taskId, stopping, typeLabel],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={`${typeLabel} ${label} · ${statusLabel(row.status, t)}`}
      testID={`background-tasks-track-row-${row.taskId}`}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function BackgroundTaskStopButton({
  label,
  taskId,
  visible,
  stopping,
  onPress,
}: {
  label: string;
  taskId: string;
  visible: boolean;
  stopping: boolean;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild disabled={!visible || stopping}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("backgroundTasks.stopAction", { label })}
            testID={`background-tasks-track-stop-${taskId}`}
            onPress={onPress}
            style={styles.actionButton}
            hitSlop={8}
            disabled={stopping}
          >
            {({ hovered: actionHovered, pressed: actionPressed }) => (
              <ThemedSquare
                size={ROW_ICON_SIZE}
                uniProps={
                  actionHovered || actionPressed
                    ? foregroundColorMapping
                    : foregroundMutedColorMapping
                }
              />
            )}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t("backgroundTasks.stopTooltip")}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
