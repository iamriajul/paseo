import React, { useSyncExternalStore, type ReactElement } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ComposerTextSource } from "@/composer/text-source";
import { formatUsdEstimate } from "./prompt-cache-cost";
import {
  estimatePromptSendUsd,
  estimatePromptTokens,
  resolveMoneyStatsPrices,
} from "./money-stats";
import { useMoneyStatsEnabled } from "./money-stats-context";
import { resolveNextMessageCost } from "./next-message-cost";
import { resolvePromptCacheView, usePromptCacheAgent, useSecondClock } from "./use-prompt-cache";

/**
 * What sending the typed prompt costs, shown before the context-window icon while there is text
 * and money stats are on: the context as the cache finds it, plus the prompt written at the
 * current TTL's write price.
 */
export function PromptSendCost({
  serverId,
  agentId,
  textSource,
}: {
  serverId: string;
  agentId: string;
  textSource: ComposerTextSource;
}): ReactElement | null {
  "use no memo";
  const enabled = useMoneyStatsEnabled();
  const promptTokens = useSyncExternalStore(
    textSource.subscribe,
    () => estimatePromptTokens(textSource.getSnapshot()),
    () => estimatePromptTokens(textSource.getSnapshot()),
  );
  const agent = usePromptCacheAgent(serverId, agentId);
  const prices = enabled ? resolveMoneyStatsPrices(agent) : null;
  const first = resolvePromptCacheView(agent, Date.now());
  // Ticks while warm, so the figure turns into a full write the second the cache expires.
  const now = useSecondClock(prices !== null && promptTokens > 0 && first.status.kind === "warm");
  if (!prices || promptTokens === 0) return null;
  const cost = resolveNextMessageCost({ agent, view: resolvePromptCacheView(agent, now) });
  if (!cost) return null;
  const usd = estimatePromptSendUsd({ cost, promptTokens, prices });
  const cold = cost.cache.kind !== "warm";
  return (
    <Text
      style={[styles.text, cold && styles.cold]}
      numberOfLines={1}
      accessibilityLabel={`Sending this costs about ${formatUsdEstimate(usd)} at API list prices`}
      testID="composer-prompt-send-cost"
    >
      ≈ {formatUsdEstimate(usd)}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  cold: {
    color: theme.colors.statusWarning,
  },
}));
