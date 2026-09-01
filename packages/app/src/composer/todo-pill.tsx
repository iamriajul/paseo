import React from "react";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { ListTodo } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { composerPillStyles } from "@/composer/pill-styles";
import { useWorkspaceTodoSummary } from "@/todos/workspace-todo-store";
import type { Theme } from "@/styles/theme";

const ThemedListTodo = withUnistyles(ListTodo);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const warningMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

export interface ComposerTodoPillProps {
  completed: number;
  total: number;
  onPress: () => void;
}

export function ComposerTodoPill({
  completed,
  total,
  onPress,
}: ComposerTodoPillProps): ReactElement {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );

  const isDone = completed === total;
  const inProgress = completed > 0;
  let iconMapping = mutedMapping;
  if (isDone) iconMapping = successMapping;
  else if (inProgress) iconMapping = warningMapping;

  let textStyle = styles.textOpen;
  if (isDone) textStyle = styles.textDone;
  else if (inProgress) textStyle = styles.textInProgress;

  return (
    <Pressable
      testID="composer-todo-pill"
      accessibilityRole="button"
      accessibilityLabel={t("workspace.todos.pillAccessible", { completed, total })}
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={bodyStyle}
    >
      <View style={styles.content}>
        <ThemedListTodo size={14} uniProps={iconMapping} />
        <Text style={textStyle} numberOfLines={1}>
          {`${completed}/${total}`}
        </Text>
      </View>
    </Pressable>
  );
}

export const WorkspaceTodoPill = memo(function WorkspaceTodoPill({
  serverId,
  workspaceId,
  onPress,
}: {
  serverId: string;
  workspaceId: string;
  onPress: () => void;
}): ReactElement | null {
  const summary = useWorkspaceTodoSummary(serverId, workspaceId);
  if (!summary || summary.total === 0) {
    return null;
  }
  return <ComposerTodoPill completed={summary.completed} total={summary.total} onPress={onPress} />;
});

const styles = StyleSheet.create((theme) => ({
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  textDone: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 16,
  },
  textInProgress: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 16,
  },
  textOpen: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 16,
  },
}));
