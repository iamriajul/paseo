import React, { memo, useCallback, useState, type ReactElement } from "react";
import { View, Text } from "react-native";
import { Database, Flame } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  FIVE_MINUTE_CACHE_WINDOW_MS,
  promptCacheHitRatio,
  type PromptCacheRequestSample,
  type PromptCacheWindows,
} from "@getpaseo/protocol/agent-cache-warm";
import {
  ComposerTrackPill,
  ComposerTrackRow,
  type ComposerTrackPillSegment,
} from "@/composer/tracks";
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
import type { PromptCacheHistoryBar, PromptCacheHistorySummary } from "./prompt-cache-history";
import { PromptCacheInsightsDialog } from "./prompt-cache-insights-dialog";
import {
  usePromptCacheAutoCompact,
  type PromptCacheAutoCompact,
} from "./use-prompt-cache-auto-compact";

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
  if (!windows) return "Auto";
  const duration = windows.cacheWindowMs <= 5 * 60 * 1000 ? "5m" : "1h";
  // Warm-up exists only for a chosen window, so without it Claude Code picked this one.
  return warmup ? duration : `Auto · ${duration}`;
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

function formatPercent(fraction: number): string {
  return `${Math.floor(fraction * 100)}%`;
}

function resolveBarFillStyle(bar: PromptCacheHistoryBar) {
  if (bar.avoidableMiss) return styles.barFillMiss;
  return bar.hit ? styles.barFillHit : styles.barFillCold;
}

function HistoryBar({ bar }: { bar: PromptCacheHistoryBar }): ReactElement {
  // A miss can read nothing at all; a sliver keeps it visible as a bar.
  const height = `${Math.round(Math.max(bar.ratio, 0.08) * 100)}%` as const;
  return (
    <View style={styles.barColumn}>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, resolveBarFillStyle(bar), { height }]} />
      </View>
    </View>
  );
}

function RequestHistory({
  history,
  misses,
}: {
  history: PromptCacheHistorySummary;
  misses: number;
}): ReactElement {
  return (
    <View style={styles.historyBlock} testID="prompt-cache-history">
      <View
        style={styles.barRow}
        role="img"
        aria-label={`Last ${history.bars.length} requests, ${formatPercent(history.cachedShare)} of input cached.`}
        testID="prompt-cache-history-chart"
      >
        {history.bars.map((bar) => (
          <HistoryBar key={bar.at} bar={bar} />
        ))}
      </View>
      <View style={styles.detailRow}>
        <Text style={styles.label} testID="prompt-cache-history-share">
          Last {history.bars.length} · {formatPercent(history.cachedShare)} cached
        </Text>
        <Text
          style={[styles.value, misses > 0 && styles.danger]}
          testID="prompt-cache-history-misses"
        >
          {misses === 1 ? "1 miss" : `${misses} misses`} this session
        </Text>
      </View>
    </View>
  );
}

function resolveAutoCompactText(autoCompact: PromptCacheAutoCompact): string {
  if (!autoCompact.enabled) return "Let it expire";
  const size =
    autoCompact.contextTokens === null ? "" : ` · ${formatTokenCount(autoCompact.contextTokens)}`;
  return autoCompact.largeEnough ? `Compact${size}` : `Compact from 200k${size} now`;
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
  const autoCompact = usePromptCacheAutoCompact(serverId, agentId);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const openInsights = useCallback(() => setInsightsOpen(true), []);
  const closeInsights = useCallback(() => setInsightsOpen(false), []);

  if (!cache.isClaude) {
    return null;
  }

  const { windows, warmup, lastPrompt, history, misses } = cache;
  const segments: ComposerTrackPillSegment[] = [
    {
      bucket:
        cache.status.kind === "busy" || cache.status.kind === "busy-expired"
          ? ("running" as const)
          : null,
      text: resolveSegmentText(cache),
    },
  ];
  if (misses > 0) {
    segments.push({ bucket: null, text: String(misses), tone: "danger" });
  }
  const canTurnOn = cache.status.kind !== "expired";

  return (
    <>
      <ComposerTrackPill
        testID="prompt-cache-pill"
        segments={segments}
        icon={warmup?.enabled ? WarmPillIcon : PillIcon}
        accessibilityLabel={resolveAccessibilityLabel(cache)}
        panelTitle="Prompt cache"
      >
        <View style={styles.panelContent}>
          <View style={styles.detailRow}>
            <Text style={styles.label}>Cache · {formatCacheWindowLabel(cache)}</Text>
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
          {history ? <RequestHistory history={history} misses={misses} /> : null}
          {warmup && windows ? (
            <View style={styles.capBlock}>
              <View style={styles.detailRow}>
                <Text style={styles.label}>Warm-up</Text>
                <Text style={styles.value} testID="prompt-cache-cap-count">
                  {resolveWarmupText(warmup)} · {warmup.pingsUsed}/{warmup.maxPings} ·{" "}
                  {formatCoveredDuration(warmup, windows)}
                </Text>
              </View>
              <CapProgress warmup={warmup} />
              <View style={styles.detailRow}>
                <Text style={styles.label}>At the cap</Text>
                <Text style={styles.value} testID="prompt-cache-auto-compact">
                  {resolveAutoCompactText(autoCompact)}
                </Text>
              </View>
              <View style={styles.actions}>
                <Button
                  size="sm"
                  variant={warmup.enabled ? "outline" : "default"}
                  testID="prompt-cache-toggle-warmup-button"
                  disabled={!warmup.enabled && !canTurnOn}
                  onPress={cache.toggleWarmup}
                  style={styles.actionButton}
                >
                  {warmup.enabled ? "Warm-up off" : "Warm-up on"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  testID="prompt-cache-toggle-auto-compact-button"
                  onPress={autoCompact.toggle}
                  style={styles.actionButton}
                >
                  {autoCompact.enabled ? "Let it expire" : "Compact at cap"}
                </Button>
              </View>
            </View>
          ) : (
            <Text style={styles.helpText}>Choose 5m or 1h under Cache window to warm it.</Text>
          )}
          <ComposerTrackRow
            onPress={openInsights}
            testID="prompt-cache-open-insights"
            accessibilityLabel="Open session cache insights"
          >
            <Text style={styles.linkText}>Session insights</Text>
          </ComposerTrackRow>
        </View>
      </ComposerTrackPill>
      {insightsOpen ? (
        <PromptCacheInsightsDialog
          serverId={serverId}
          agentId={agentId}
          visible
          onClose={closeInsights}
          revision={cache.requests}
          cacheWindowMs={windows?.cacheWindowMs ?? FIVE_MINUTE_CACHE_WINDOW_MS}
        />
      ) : null}
    </>
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
  historyBlock: {
    gap: theme.spacing[2],
  },
  barRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
  },
  barColumn: {
    flex: 1,
    maxWidth: 12,
    gap: 2,
  },
  barTrack: {
    height: 32,
    borderRadius: 2,
    backgroundColor: theme.colors.surface3,
    justifyContent: "flex-end",
    overflow: "hidden",
  },
  barFill: {
    width: "100%",
  },
  barFillHit: {
    backgroundColor: theme.colors.statusSuccess,
  },
  barFillMiss: {
    backgroundColor: theme.colors.statusDanger,
  },
  barFillCold: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  danger: {
    color: theme.colors.statusDanger,
  },
  actions: {
    marginTop: theme.spacing[1],
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
  linkText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  helpText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
  },
}));
