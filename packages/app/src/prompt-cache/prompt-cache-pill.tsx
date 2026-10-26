import React, { memo, type ReactElement } from "react";
import { View, Text } from "react-native";
import { Database, Flame } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ComposerTrackPill } from "@/composer/tracks";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { usePromptCache } from "./use-prompt-cache";

const ThemedDatabase = withUnistyles(Database);
const ThemedFlame = withUnistyles(Flame);

const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warmIconColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

const PillIcon = memo(function PillIcon(): ReactElement {
  return <ThemedDatabase size={14} uniProps={iconColorMapping} />;
});

const WarmPillIcon = memo(function WarmPillIcon(): ReactElement {
  return <ThemedFlame size={14} uniProps={warmIconColorMapping} />;
});

function formatCacheWindowLabel(cacheWindowMs: number, isSubagent: boolean): string {
  if (cacheWindowMs <= 5 * 60 * 1000) {
    return isSubagent ? "5 minutes (subagent)" : "5 minutes";
  }
  return isSubagent ? "1 hour" : "1 hour (Claude Code)";
}

function formatCoveredDuration(warmIntervalMs: number, maxConsecutivePings: number): string {
  const totalMinutes = Math.round((warmIntervalMs * maxConsecutivePings) / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h${remainingMinutes}m`;
}

export const PromptCachePill = memo(function PromptCachePill({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const cache = usePromptCache(serverId, agentId);

  if (!cache.isClaude) {
    return null;
  }

  let segmentText = `cache · ${cache.countdownText}`;
  if (cache.isBusy) {
    segmentText = "caching";
  } else if (cache.isCapped) {
    segmentText = cache.isWarm ? "warm · capped" : "cache · expired";
  } else if (cache.isWarmupEnabled) {
    segmentText = `warm · ${cache.nextPingCountdownText}`;
  }

  let statusText = "Cache expired";
  if (cache.isBusy) {
    statusText = "Active turn in flight";
  } else if (cache.isWarm) {
    statusText = `Expires ${cache.countdownText}`;
  }

  let warmupText = "Disabled";
  if (cache.isWarmupEnabled) {
    if (cache.isBusy) {
      warmupText = "Active (resets after turn)";
    } else if (cache.isCapped) {
      warmupText = `Capped (${cache.consecutivePings}/${cache.maxConsecutivePings} pings)`;
    } else {
      warmupText = `Next warm-up ${cache.nextPingCountdownText}`;
    }
  }

  const segments = [
    {
      bucket: cache.isBusy ? ("running" as const) : null,
      text: segmentText,
    },
  ];

  let accessibilityLabel = `Claude prompt cache: ${cache.countdownText}`;
  if (cache.isBusy) {
    accessibilityLabel = "Claude prompt cache: caching";
  } else if (cache.isCapped) {
    accessibilityLabel = `Claude cache warm-up: capped after ${cache.consecutivePings} pings`;
  } else if (cache.isWarmupEnabled) {
    accessibilityLabel = `Claude cache warm-up: next tick ${cache.nextPingCountdownText}`;
  }

  return (
    <ComposerTrackPill
      testID="prompt-cache-pill"
      segments={segments}
      icon={cache.isWarmupEnabled ? WarmPillIcon : PillIcon}
      accessibilityLabel={accessibilityLabel}
      panelTitle="Prompt Cache Warm-up"
    >
      <View style={styles.panelContent}>
        <View style={styles.detailRow}>
          <Text style={styles.label}>Cache window</Text>
          <Text style={styles.value}>
            {formatCacheWindowLabel(cache.cacheWindowMs, cache.isSubagent)}
          </Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.label}>Cache status</Text>
          <Text style={styles.value}>{statusText}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.label}>Auto warm-up</Text>
          <Text style={styles.value}>{warmupText}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.label}>Idle auto-cap</Text>
          <Text style={styles.value}>
            {cache.maxConsecutivePings} pings (
            {formatCoveredDuration(cache.warmIntervalMs, cache.maxConsecutivePings)})
          </Text>
        </View>
        <View style={styles.actions}>
          <Button
            size="sm"
            variant={cache.isWarmupEnabled ? "outline" : "default"}
            testID="prompt-cache-toggle-warmup-button"
            onPress={cache.toggleWarmup}
          >
            {cache.isWarmupEnabled ? "Turn off auto warm-up" : "Turn on auto warm-up"}
          </Button>
        </View>
      </View>
    </ComposerTrackPill>
  );
});

const styles = StyleSheet.create((theme: Theme) => ({
  panelContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  value: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  actions: {
    marginTop: theme.spacing[1],
    flexDirection: "row",
    justifyContent: "flex-end",
  },
}));
