import { useCallback, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CalendarClock, Pause, Play, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { formatNextRun } from "@/utils/schedule-format";
import type { HeartbeatRow } from "./select";
import { buildHeartbeatPillPresentation } from "./track-presentation";

const ThemedCalendarClock = withUnistyles(CalendarClock);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedTrash2 = withUnistyles(Trash2);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

export interface HeartbeatsTrackProps {
  rows: HeartbeatRow[];
  onOpenRow: (row: HeartbeatRow) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (row: HeartbeatRow) => void;
  pendingIds?: ReadonlySet<string>;
}

const ROW_ICON_SIZE = 14;

function rowPrimaryLabel(row: HeartbeatRow): string {
  if (row.kind === "paseo") {
    const name = row.name?.trim();
    if (name) return name;
    const prompt = row.prompt.trim();
    if (prompt) return prompt;
    return row.id;
  }
  const prompt = row.prompt.trim();
  if (prompt) return prompt;
  return row.id;
}

function rowSecondaryLabel(
  row: HeartbeatRow,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  if (row.kind === "paseo") {
    if (row.status === "paused") {
      return `${row.cadenceLabel} · ${t("heartbeats.statusPaused")}`;
    }
    const next = formatNextRun(row.nextRunAt);
    if (next) {
      return `${row.cadenceLabel} · ${t("heartbeats.nextRun", { when: next })}`;
    }
    return row.cadenceLabel;
  }
  if (row.nextHint?.trim()) {
    return `${row.scheduleLabel} · ${row.nextHint}`;
  }
  return row.scheduleLabel;
}

export function HeartbeatsTrack({
  rows,
  onOpenRow,
  onPause,
  onResume,
  onDelete,
  pendingIds,
}: HeartbeatsTrackProps): ReactElement | null {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return null;
  }

  const pill = buildHeartbeatPillPresentation(t, rows);

  return (
    <ComposerTrackPill
      testID="heartbeats-track-header"
      segments={pill.segments}
      accessibilityLabel={pill.accessibilityLabel}
      panelTitle={t("heartbeats.header")}
    >
      {rows.map((row) => (
        <HeartbeatsTrackRow
          key={`${row.kind}:${row.id}`}
          row={row}
          pending={pendingIds?.has(row.id) === true}
          onOpenRow={onOpenRow}
          onPause={onPause}
          onResume={onResume}
          onDelete={onDelete}
        />
      ))}
    </ComposerTrackPill>
  );
}

function HeartbeatsTrackRow({
  row,
  pending,
  onOpenRow,
  onPause,
  onResume,
  onDelete,
}: {
  row: HeartbeatRow;
  pending: boolean;
  onOpenRow: (row: HeartbeatRow) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (row: HeartbeatRow) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const label = rowPrimaryLabel(row);
  const meta = rowSecondaryLabel(row, t);
  const handlePress = useCallback(() => {
    onOpenRow(row);
  }, [onOpenRow, row]);
  const handlePausePress = useCallback(() => {
    onPause(row.id);
  }, [onPause, row.id]);
  const handleResumePress = useCallback(() => {
    onResume(row.id);
  }, [onResume, row.id]);
  const handleDeletePress = useCallback(() => {
    onDelete(row);
  }, [onDelete, row]);
  const actionsAlwaysVisible = isNative || isCompact;

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <HeartbeatLeadingIcon row={row} />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.rowTrailing} numberOfLines={1}>
          {meta}
        </Text>
        <HeartbeatRowActions
          row={row}
          label={label}
          visible={actionsAlwaysVisible || active}
          pending={pending}
          onPausePress={handlePausePress}
          onResumePress={handleResumePress}
          onDeletePress={handleDeletePress}
        />
      </>
    ),
    [
      actionsAlwaysVisible,
      handleDeletePress,
      handlePausePress,
      handleResumePress,
      label,
      meta,
      pending,
      row,
    ],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={label}
      testID={`heartbeats-track-row-${row.kind}-${row.id}`}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function HeartbeatLeadingIcon({ row }: { row: HeartbeatRow }): ReactElement {
  if (row.kind === "provider") {
    const Icon = getProviderIcon(row.provider);
    return <Icon size={ROW_ICON_SIZE} color={styles.providerIcon.color} />;
  }
  return <ThemedCalendarClock size={ROW_ICON_SIZE} uniProps={foregroundMutedColorMapping} />;
}

function HeartbeatRowActions({
  row,
  label,
  visible,
  pending,
  onPausePress,
  onResumePress,
  onDeletePress,
}: {
  row: HeartbeatRow;
  label: string;
  visible: boolean;
  pending: boolean;
  onPausePress: () => void;
  onResumePress: () => void;
  onDeletePress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      {row.kind === "paseo" && row.status === "paused" ? (
        <HeartbeatActionButton
          accessibilityLabel={t("heartbeats.resumeAction", { label })}
          testID={`heartbeats-track-resume-${row.id}`}
          tooltipLabel={t("heartbeats.resumeTooltip")}
          icon="play"
          visible={visible}
          disabled={pending}
          onPress={onResumePress}
        />
      ) : null}
      {row.kind === "paseo" && row.status === "active" ? (
        <HeartbeatActionButton
          accessibilityLabel={t("heartbeats.pauseAction", { label })}
          testID={`heartbeats-track-pause-${row.id}`}
          tooltipLabel={t("heartbeats.pauseTooltip")}
          icon="pause"
          visible={visible}
          disabled={pending}
          onPress={onPausePress}
        />
      ) : null}
      <HeartbeatActionButton
        accessibilityLabel={t("heartbeats.deleteAction", { label })}
        testID={`heartbeats-track-delete-${row.kind}-${row.id}`}
        tooltipLabel={t("heartbeats.deleteTooltip")}
        icon="delete"
        visible={visible}
        disabled={pending}
        onPress={onDeletePress}
      />
    </View>
  );
}

function HeartbeatActionButton({
  accessibilityLabel,
  testID,
  tooltipLabel,
  icon,
  visible,
  disabled,
  onPress,
}: {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  icon: "pause" | "play" | "delete";
  visible: boolean;
  disabled: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={!visible || disabled}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={onPress}
          style={styles.actionButton}
          hitSlop={8}
          disabled={disabled}
        >
          {({ hovered: actionHovered, pressed: actionPressed }) => {
            const active = actionHovered || actionPressed;
            if (icon === "delete") {
              return (
                <ThemedTrash2
                  size={ROW_ICON_SIZE}
                  uniProps={active ? destructiveColorMapping : foregroundMutedColorMapping}
                />
              );
            }
            if (icon === "play") {
              return (
                <ThemedPlay
                  size={ROW_ICON_SIZE}
                  uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              );
            }
            return (
              <ThemedPause
                size={ROW_ICON_SIZE}
                uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            );
          }}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
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
  rowTrailing: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  providerIcon: {
    color: theme.colors.foregroundMuted,
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
