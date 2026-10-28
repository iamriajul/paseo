import React, { memo, type ReactElement } from "react";
import { View, Text } from "react-native";
import { Database, Flame } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  promptCacheHitRatio,
  type PromptCacheRequestSample,
  type PromptCacheWindows,
} from "@getpaseo/protocol/agent-cache-warm";
import { ComposerTrackPill } from "@/composer/tracks";
import { Button } from "@/components/ui/button";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { formatCountdownClock, formatPreciseDuration } from "@/usage/format";
import type { Theme } from "@/styles/theme";
import {
  usePromptCache,
  type PromptCacheState,
  type PromptCacheStatus,
  type PromptCacheWarmup,
} from "./use-prompt-cache";

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

function formatCacheWindowLabel(cache: PromptCacheState): string {
  const { windows, warmup } = cache;
  if (!windows) return "Automatic";
  const duration = windows.cacheWindowMs <= 5 * 60 * 1000 ? "5 minutes" : "1 hour";
  // Warm-up exists only for a chosen window, so without it Claude Code picked this one.
  return warmup ? duration : `Automatic · ${duration}`;
}

function formatCoveredDuration(warmup: PromptCacheWarmup, windows: PromptCacheWindows): string {
  return formatPreciseDuration(windows.warmIntervalMs * warmup.maxPings);
}

function resolveSegmentText(cache: PromptCacheState): string {
  const { status, warmup } = cache;
  switch (status.kind) {
    case "automatic":
      return "cache · auto";
    case "busy":
      return status.remainingMs === null
        ? "caching"
        : `cache · ${formatCountdownClock(status.remainingMs)}`;
    case "busy-expired":
    case "expired":
      return "cache · expired";
    case "awaiting-question":
      return `question · ${formatCountdownClock(status.remainingMs)}`;
    case "awaiting-permission":
      return `permission · ${formatCountdownClock(status.remainingMs)}`;
    case "warm":
      if (warmup?.plan.kind === "next-ping") {
        return `warm · ${formatCountdownClock(warmup.plan.remainingMs)}`;
      }
      if (warmup?.plan.kind === "capped") {
        return `capped · ${formatCountdownClock(status.remainingMs)}`;
      }
      return `cache · ${formatCountdownClock(status.remainingMs)}`;
  }
}

function resolveStatusText(status: PromptCacheStatus): string {
  switch (status.kind) {
    case "automatic":
      return "Claude Code picks the window";
    case "busy":
      return status.remainingMs === null
        ? "Active turn in flight"
        : `Turn in flight · expires in ${formatCountdownClock(status.remainingMs)} without a new request`;
    case "busy-expired":
      return "Expired during this turn · the next request writes it again";
    case "expired":
      return "Cache expired";
    case "awaiting-question":
      return `Awaiting answer · expires in ${formatCountdownClock(status.remainingMs)}`;
    case "awaiting-permission":
      return `Awaiting permission · expires in ${formatCountdownClock(status.remainingMs)}`;
    case "warm":
      return `Expires in ${formatCountdownClock(status.remainingMs)}`;
  }
}

function resolveWarmupText(warmup: PromptCacheWarmup): string {
  const { plan } = warmup;
  switch (plan.kind) {
    case "off":
      return "Off";
    case "after-turn":
      return "Resumes after this turn";
    case "expired":
      return "Paused (cache expired)";
    case "capped":
      return "Capped for this idle stretch";
    case "parent-answers":
      return "Waits for the parent agent";
    case "waits-for-permission":
      return "Paused while awaiting permission";
    case "pauses-question":
      return `Question closes in ${formatCountdownClock(plan.remainingMs)}`;
    case "next-ping":
      return `Next in ${formatCountdownClock(plan.remainingMs)}`;
  }
}

function resolveLastPromptText(sample: PromptCacheRequestSample): string {
  const ratio = promptCacheHitRatio(sample);
  if (ratio === null) {
    return "No input recorded";
  }
  if (sample.readTokens === 0) {
    return `Missed · wrote ${formatTokenCount(sample.writeTokens)}`;
  }
  const percent = Math.floor(ratio * 100);
  return `${percent}% cached · ${formatTokenCount(sample.readTokens)} read · ${formatTokenCount(sample.writeTokens)} written`;
}

function resolveAccessibilityLabel(cache: PromptCacheState): string {
  return `Claude prompt cache: ${resolveSegmentText(cache)}`;
}

function CapProgress({ warmup }: { warmup: PromptCacheWarmup }): ReactElement {
  const fraction = warmup.maxPings > 0 ? warmup.pingsUsed / warmup.maxPings : 0;
  return (
    <View
      style={styles.capTrack}
      testID="prompt-cache-cap-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={warmup.maxPings}
      aria-valuenow={warmup.pingsUsed}
    >
      <View style={[styles.capFill, { width: `${Math.round(fraction * 100)}%` }]} />
    </View>
  );
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

  const { windows, warmup, lastPrompt } = cache;
  const segments = [
    {
      bucket:
        cache.status.kind === "busy" || cache.status.kind === "busy-expired"
          ? ("running" as const)
          : null,
      text: resolveSegmentText(cache),
    },
  ];
  const canTurnOn = cache.status.kind !== "expired";

  return (
    <ComposerTrackPill
      testID="prompt-cache-pill"
      segments={segments}
      icon={warmup?.enabled ? WarmPillIcon : PillIcon}
      accessibilityLabel={resolveAccessibilityLabel(cache)}
      panelTitle="Prompt Cache Warm-up"
    >
      <View style={styles.panelContent}>
        <View style={styles.detailRow}>
          <Text style={styles.label}>Cache window</Text>
          <Text style={styles.value}>{formatCacheWindowLabel(cache)}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.label}>Cache status</Text>
          <Text style={styles.value}>{resolveStatusText(cache.status)}</Text>
        </View>
        {lastPrompt ? (
          <View style={styles.detailRow}>
            <Text style={styles.label}>
              {lastPrompt.isWarmPing ? "Last warm-up" : "Last prompt"}
            </Text>
            <Text style={styles.value} testID="prompt-cache-last-prompt">
              {resolveLastPromptText(lastPrompt)}
            </Text>
          </View>
        ) : null}
        {warmup && windows ? (
          <>
            <View style={styles.detailRow}>
              <Text style={styles.label}>Auto warm-up</Text>
              <Text style={styles.value}>{resolveWarmupText(warmup)}</Text>
            </View>
            <View style={styles.capBlock}>
              <View style={styles.detailRow}>
                <Text style={styles.label}>Idle auto-cap</Text>
                <Text style={styles.value} testID="prompt-cache-cap-count">
                  {warmup.pingsUsed} / {warmup.maxPings} · {formatCoveredDuration(warmup, windows)}
                </Text>
              </View>
              <CapProgress warmup={warmup} />
              <Text style={styles.helpText}>Cap resets when you send a message</Text>
              <View style={styles.detailRow}>
                <Text style={styles.label}>Total warm-ups</Text>
                <Text style={styles.value} testID="prompt-cache-total-pings">
                  {warmup.totalPings}
                </Text>
              </View>
            </View>
            <View style={styles.actions}>
              <Button
                size="sm"
                variant={warmup.enabled ? "outline" : "default"}
                testID="prompt-cache-toggle-warmup-button"
                disabled={!warmup.enabled && !canTurnOn}
                onPress={cache.toggleWarmup}
              >
                {warmup.enabled ? "Turn off auto warm-up" : "Turn on auto warm-up"}
              </Button>
              {!warmup.enabled && !canTurnOn ? (
                <Text style={styles.helpText}>
                  Cache is expired. Send a prompt to re-warm before turning on auto warm-up.
                </Text>
              ) : null}
            </View>
          </>
        ) : (
          <Text style={styles.helpText}>
            Choose 5 minutes or 1 hour under Cache window to use auto warm-up.
          </Text>
        )}
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
  capBlock: {
    gap: theme.spacing[1],
  },
  capTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  capFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.statusWarning,
  },
  actions: {
    marginTop: theme.spacing[1],
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[1],
  },
  helpText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
  },
}));
