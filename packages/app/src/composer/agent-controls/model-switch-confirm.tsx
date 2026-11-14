import React, { type ReactElement, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { liveCacheRemainingMs } from "@/prompt-cache/cache-window-change";
import { usePromptCache } from "@/prompt-cache/use-prompt-cache";
import { formatCountdownClock } from "@/usage/format";
import type { Theme } from "@/styles/theme";

const CONFIRM_HEADER = { title: "Switch model?" };

function confirmCopy(input: {
  nextModelLabel: string;
  remainingMs: number | null;
  contextTokens: number | null;
  canFork: boolean;
}): string {
  const live =
    input.remainingMs === null
      ? "Your cache is warm."
      : `Your cache stays warm for another ${formatCountdownClock(input.remainingMs)}.`;
  const size =
    input.contextTokens === null
      ? "the whole conversation"
      : `the whole conversation (${formatTokenCount(input.contextTokens)} tokens)`;
  const fork = input.canFork
    ? ` A fork keeps this session and its cache, and continues the conversation on ${input.nextModelLabel} in a new tab.`
    : "";
  return `${live} A cache belongs to one model, so ${input.nextModelLabel} writes ${size} again at full price.${fork}`;
}

interface ModelSwitchConfirmProps {
  serverId: string;
  agentId: string;
  nextModelLabel: string;
  contextTokens: number | null;
  /** Null when this agent or host cannot fork onto another model. */
  onFork: (() => void) | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Mounted only while a switch is pending, so the cache clock ticks only while the dialog is open. */
export function ModelSwitchConfirm({
  serverId,
  agentId,
  nextModelLabel,
  contextTokens,
  onFork,
  onCancel,
  onConfirm,
}: ModelSwitchConfirmProps): ReactElement {
  const { status } = usePromptCache(serverId, agentId);
  const remainingMs = liveCacheRemainingMs(status);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="ghost" testID="model-switch-cancel" onPress={onCancel}>
          Cancel
        </Button>
        {onFork ? (
          <Button variant="outline" testID="model-switch-fork" onPress={onFork}>
            {`Fork on ${nextModelLabel}`}
          </Button>
        ) : null}
        <Button variant="default" testID="model-switch-confirm" onPress={onConfirm}>
          Switch anyway
        </Button>
      </View>
    ),
    [nextModelLabel, onCancel, onConfirm, onFork],
  );

  return (
    <AdaptiveModalSheet header={CONFIRM_HEADER} visible onClose={onCancel} footer={footer}>
      <Text style={styles.text}>
        {confirmCopy({ nextModelLabel, remainingMs, contextTokens, canFork: onFork !== null })}
      </Text>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    padding: theme.spacing[3],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
}));
