import React, { type ReactElement, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { liveCacheRemainingMs } from "@/prompt-cache/cache-window-change";
import { usePromptCache } from "@/prompt-cache/use-prompt-cache";
import { formatCountdownClock } from "@/usage/format";
import type { Theme } from "@/styles/theme";

const CONFIRM_HEADER = { title: "Change the Cache window?" };
const EXPIRED_COPY =
  "Your cache has expired, so there is nothing to drop. Writes cost 1.25× input on 5m and 2× on 1h.";

function liveCopy(remainingMs: number): string {
  return `Your cache expires in ${formatCountdownClock(remainingMs)}. Changing the window may drop this cache, so your next request may write it again. Writes cost 1.25× input on 5m and 2× on 1h.`;
}

/** Mounted only while a change is pending, so the cache clock ticks only while the dialog is open. */
export function CacheWindowConfirmForAgent({
  serverId,
  agentId,
  onCancel,
  onConfirm,
}: {
  serverId: string;
  agentId: string;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const { status } = usePromptCache(serverId, agentId);
  return (
    <CacheWindowConfirm
      remainingMs={liveCacheRemainingMs(status)}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** `remainingMs` is the live countdown, or null once no live cache has time left. */
export function CacheWindowConfirm({
  remainingMs,
  onCancel,
  onConfirm,
}: {
  remainingMs: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button size="sm" variant="outline" testID="cache-window-cancel" onPress={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="default" testID="cache-window-confirm" onPress={onConfirm}>
          Change window
        </Button>
      </View>
    ),
    [onCancel, onConfirm],
  );

  return (
    <AdaptiveModalSheet header={CONFIRM_HEADER} visible onClose={onCancel} footer={footer}>
      <Text style={styles.text}>{remainingMs === null ? EXPIRED_COPY : liveCopy(remainingMs)}</Text>
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
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
}));
