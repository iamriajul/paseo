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

function resolvePillSegmentText(cache: ReturnType<typeof usePromptCache>): string {
  if (cache.isBusy) {
    return "caching";
  }
  if (cache.hasPendingQuestion) {
    return cache.isWarm ? `question · ${cache.countdownText}` : "question · expired";
  }
  if (cache.hasPendingPermission) {
    return cache.isWarm ? `permission · ${cache.countdownText}` : "permission · expired";
  }
  if (cache.isCapped) {
    return cache.isWarm ? "warm · capped" : "cache · expired";
  }
  if (cache.isWarmupEnabled) {
    return `warm · ${cache.nextPingCountdownText}`;
  }
  return `cache · ${cache.countdownText}`;
}

function resolvePillStatusText(cache: ReturnType<typeof usePromptCache>): string {
  if (cache.isBusy) {
    return "Active turn in flight";
  }
  if (cache.hasPendingQuestion) {
    return cache.isWarm
      ? `Awaiting answer (expires ${cache.countdownText})`
      : "Awaiting answer (cache expired)";
  }
  if (cache.hasPendingPermission) {
    return cache.isWarm
      ? `Awaiting permission (expires ${cache.countdownText})`
      : "Awaiting permission (cache expired)";
  }
  if (cache.isWarm) {
    return `Expires ${cache.countdownText}`;
  }
  return "Cache expired";
}

function resolvePillWarmupText(cache: ReturnType<typeof usePromptCache>): string {
  if (!cache.isWarmupEnabled) {
    return "Disabled";
  }
  if (cache.isBusy) {
    return "Active (resets after turn)";
  }
  if (cache.hasPendingPermission) {
    return "Paused while awaiting your response";
  }
  if (cache.isCapped) {
    return `Capped (${cache.consecutivePings}/${cache.maxConsecutivePings} pings)`;
  }
  if (!cache.isWarm) {
    return "Paused (cache expired)";
  }
  return `Next warm-up ${cache.nextPingCountdownText}`;
}

function resolvePillAccessibilityLabel(cache: ReturnType<typeof usePromptCache>): string {
  if (cache.isBusy) {
    return "Claude prompt cache: caching";
  }
  if (cache.hasPendingQuestion) {
    return `Claude prompt cache: awaiting answer, expires ${cache.countdownText}`;
  }
  if (cache.hasPendingPermission) {
    return `Claude prompt cache: awaiting permission, expires ${cache.countdownText}`;
  }
  if (cache.isCapped) {
    return `Claude cache warm-up: capped after ${cache.consecutivePings} pings`;
  }
  if (cache.isWarmupEnabled) {
    return `Claude cache warm-up: next tick ${cache.nextPingCountdownText}`;
  }
  return `Claude prompt cache: ${cache.countdownText}`;
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

  const segmentText = resolvePillSegmentText(cache);
  const statusText = resolvePillStatusText(cache);
  const warmupText = resolvePillWarmupText(cache);
  const accessibilityLabel = resolvePillAccessibilityLabel(cache);

  const segments = [
    {
      bucket: cache.isBusy ? ("running" as const) : null,
      text: segmentText,
    },
  ];

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
            disabled={!cache.isWarm && !cache.isWarmupEnabled}
            onPress={cache.toggleWarmup}
          >
            {cache.isWarmupEnabled ? "Turn off auto warm-up" : "Turn on auto warm-up"}
          </Button>
          {!cache.isWarm && !cache.isWarmupEnabled ? (
            <Text style={styles.disabledHelpText}>
              Cache is expired. Send a prompt to re-warm before turning on auto warm-up.
            </Text>
          ) : null}
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
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[1],
  },
  disabledHelpText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
    marginTop: theme.spacing[1],
  },
}));
