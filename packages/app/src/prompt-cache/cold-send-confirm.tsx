import React, { type ReactElement, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { COLD_SEND_COMPACT_MODEL_LABEL } from "./cache-guards";
import type { Theme } from "@/styles/theme";

const CONFIRM_HEADER = { title: "Your cache has expired" };

function confirmCopy(input: {
  modelLabel: string;
  contextTokens: number | null;
  canCompact: boolean;
}): string {
  const size =
    input.contextTokens === null
      ? "the whole conversation"
      : `the whole conversation (${formatTokenCount(input.contextTokens)} tokens)`;
  const compact = input.canCompact
    ? ` Compacting on ${COLD_SEND_COMPACT_MODEL_LABEL} first reads it at a fraction of that price, then ${input.modelLabel} answers from the summary with its own effort.`
    : "";
  return `Sending now makes ${input.modelLabel} write ${size} again at full price.${compact}`;
}

interface ColdSendConfirmProps {
  modelLabel: string;
  contextTokens: number | null;
  /** Null when the host cannot compact on another model before sending. */
  onCompactFirst: (() => void) | null;
  onCancel: () => void;
  onSend: () => void;
}

export function ColdSendConfirm({
  modelLabel,
  contextTokens,
  onCompactFirst,
  onCancel,
  onSend,
}: ColdSendConfirmProps): ReactElement {
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button size="sm" variant="ghost" testID="cold-send-cancel" onPress={onCancel}>
          Cancel
        </Button>
        {onCompactFirst ? (
          <Button size="sm" variant="outline" testID="cold-send-compact" onPress={onCompactFirst}>
            {`Compact on ${COLD_SEND_COMPACT_MODEL_LABEL}, then send`}
          </Button>
        ) : null}
        <Button size="sm" variant="default" testID="cold-send-confirm" onPress={onSend}>
          Send anyway
        </Button>
      </View>
    ),
    [onCancel, onCompactFirst, onSend],
  );

  return (
    <AdaptiveModalSheet header={CONFIRM_HEADER} visible onClose={onCancel} footer={footer}>
      <Text style={styles.text}>
        {confirmCopy({ modelLabel, contextTokens, canCompact: onCompactFirst !== null })}
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
