import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { formatCountdownClock } from "@/usage/format";
import { formatUsdEstimate } from "./prompt-cache-cost";
import { resolveNextMessageCost, type NextMessageCost } from "./next-message-cost";
import { resolvePromptCacheView, usePromptCacheAgent, useSecondClock } from "./use-prompt-cache";

export function describeNextMessage(cost: NextMessageCost): { headline: string; detail: string } {
  const context = formatTokenCount(cost.contextTokens);
  const warm = formatUsdEstimate(cost.warmUsd);
  const cold = formatUsdEstimate(cost.coldUsd);
  switch (cost.cache.kind) {
    case "warm":
      return {
        headline: `Reads ${context} from cache ≈ ${warm}`,
        detail: `Cache warm for ${formatCountdownClock(cost.cache.remainingMs)} · after that it writes it again ≈ ${cold}`,
      };
    case "cold":
      return {
        headline: `Writes ${context} again ≈ ${cold}`,
        detail: `Cache expired · warm it would have read it for ${warm}`,
      };
    case "unknown":
      return {
        headline: `${context} context · ${warm} warm, ${cold} cold`,
        detail: "Auto cache window · the expiry is not known yet",
      };
  }
}

/** Says how much of the session cost was cache warm-ups, which Claude Code does not count. */
export function WarmUpCostNote({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const warmUpCostUsd = usePromptCacheAgent(serverId, agentId)?.warmUpCostUsd;
  if (!warmUpCostUsd || warmUpCostUsd <= 0) return null;
  return (
    <Text style={styles.detail} testID="session-cost-warm-ups">
      Includes ≈ {formatUsdEstimate(warmUpCostUsd)} of cache warm-ups
    </Text>
  );
}

/**
 * The price of the next message to a Claude agent, read off its last request. It answers "is it
 * worth resuming this": a live cache reads the context cheaply, an expired one writes it again.
 */
export function NextMessageCostSection({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  "use no memo";
  const agent = usePromptCacheAgent(serverId, agentId);
  const first = resolvePromptCacheView(agent, Date.now());
  const ticking = first.status.kind === "warm" || first.status.kind === "busy";
  const now = useSecondClock(ticking);
  const cost = resolveNextMessageCost({ agent, view: resolvePromptCacheView(agent, now) });
  if (!cost) return null;
  const { headline, detail } = describeNextMessage(cost);
  return (
    <View style={styles.section} testID="next-message-cost">
      <Text style={styles.title}>Next message</Text>
      <Text
        style={[styles.headline, cost.cache.kind === "cold" && styles.cold]}
        testID="next-message-cost-headline"
      >
        {headline}
      </Text>
      <Text style={styles.detail}>{detail}</Text>
      {cost.runtimeActive === false ? (
        <Text style={styles.detail} testID="next-message-cost-runtime">
          Claude process stopped · the message starts it again
        </Text>
      ) : null}
      <Text style={styles.footnote}>Input at API list prices; output not included</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  headline: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  cold: {
    color: theme.colors.statusWarning,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  footnote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    opacity: 0.8,
  },
}));
