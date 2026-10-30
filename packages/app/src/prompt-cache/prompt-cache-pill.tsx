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
import type {
  PromptCacheHistoryBar,
  PromptCacheHistorySummary,
  PromptCacheHitCount,
  PromptCacheLastReturn,
} from "./prompt-cache-history";

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

function formatHitCount(count: PromptCacheHitCount): string {
  return count.total === 0 ? "None yet" : `${count.hit} of ${count.total} hit`;
}

function formatPercent(fraction: number): string {
  return `${Math.floor(fraction * 100)}%`;
}

function resolveMissesText(history: PromptCacheHistorySummary): string {
  const { missesAfterExpiry, missesWhileWarm } = history;
  if (missesAfterExpiry === 0 && missesWhileWarm === 0) return "None";
  return `${missesAfterExpiry} after expiry · ${missesWhileWarm} while warm`;
}

function resolveLastReturnText(lastReturn: PromptCacheLastReturn): string {
  const away = `${formatPreciseDuration(lastReturn.awayMs)} away`;
  const warmUps = lastReturn.warmUps === 1 ? "1 warm-up" : `${lastReturn.warmUps} warm-ups`;
  const outcome = lastReturn.hit ? `${formatPercent(lastReturn.ratio)} cached` : "missed";
  return `${away} · ${warmUps} · ${outcome}`;
}

function resolveHistoryAccessibilityLabel(history: PromptCacheHistorySummary): string {
  return `Last ${history.bars.length} requests: ${formatHitCount(history.requests)}, ${formatPercent(history.cachedShare)} of input cached.`;
}

function resolveBarFillStyle(bar: PromptCacheHistoryBar) {
  return bar.hit ? styles.barFillHit : styles.barFillMiss;
}

function resolveBarMarkerStyle(bar: PromptCacheHistoryBar) {
  if (bar.kind === "warm-up") return styles.markerWarmUp;
  if (bar.kind === "turn") return styles.markerTurn;
  return null;
}

function HistoryBar({ bar }: { bar: PromptCacheHistoryBar }): ReactElement {
  // A miss can read nothing at all; a sliver keeps it visible as a bar.
  const height = `${Math.round(Math.max(bar.ratio, 0.08) * 100)}%` as const;
  return (
    <View style={styles.barColumn}>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, resolveBarFillStyle(bar), { height }]} />
      </View>
      <View style={[styles.marker, resolveBarMarkerStyle(bar)]} />
    </View>
  );
}

function HistoryRow({
  label,
  value,
  testID,
}: {
  label: string;
  value: string;
  testID: string;
}): ReactElement {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

function RequestHistory({ history }: { history: PromptCacheHistorySummary }): ReactElement {
  return (
    <View style={styles.historyBlock} testID="prompt-cache-history">
      <HistoryRow
        label="Recent requests"
        value={`${history.bars.length} · ${formatPercent(history.cachedShare)} of input cached`}
        testID="prompt-cache-history-share"
      />
      <View
        style={styles.barRow}
        role="img"
        aria-label={resolveHistoryAccessibilityLabel(history)}
        testID="prompt-cache-history-chart"
      >
        {history.bars.map((bar) => (
          <HistoryBar key={bar.at} bar={bar} />
        ))}
      </View>
      <View style={styles.legend}>
        <View style={[styles.marker, styles.markerTurn]} />
        <Text style={styles.legendText}>Turn start</Text>
        <View style={[styles.marker, styles.markerWarmUp]} />
        <Text style={styles.legendText}>Warm-up</Text>
        <Text style={styles.legendText}>· height is the cached share</Text>
      </View>
      <HistoryRow
        label="Requests"
        value={formatHitCount(history.requests)}
        testID="prompt-cache-history-requests"
      />
      <HistoryRow
        label="After time away"
        value={formatHitCount(history.returns)}
        testID="prompt-cache-history-returns"
      />
      <HistoryRow
        label="Warm-ups"
        value={formatHitCount(history.warmUps)}
        testID="prompt-cache-history-warm-ups"
      />
      <HistoryRow
        label="Misses"
        value={resolveMissesText(history)}
        testID="prompt-cache-history-misses"
      />
      {history.lastReturn ? (
        <HistoryRow
          label="Last return"
          value={resolveLastReturnText(history.lastReturn)}
          testID="prompt-cache-history-last-return"
        />
      ) : null}
    </View>
  );
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

  const { windows, warmup, lastPrompt, history } = cache;
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
        {history ? <RequestHistory history={history} /> : null}
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
            Choose 5m or 1h under Cache window to use auto warm-up.
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
  marker: {
    height: 6,
    width: 6,
    borderRadius: 3,
    alignSelf: "center",
  },
  markerTurn: {
    backgroundColor: theme.colors.foreground,
  },
  markerWarmUp: {
    backgroundColor: theme.colors.statusWarning,
  },
  legend: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  legendText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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
