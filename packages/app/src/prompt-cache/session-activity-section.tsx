import React, { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PromptCacheHistoryEntry } from "@getpaseo/protocol/agent-cache-warm";
import type { Theme } from "@/styles/theme";
import { formatPreciseDuration } from "@/usage/format";
import { formatUsdEstimate } from "./prompt-cache-cost";
import type { RequestPricer } from "./prompt-cache-insights";
import {
  compareCacheStrategies,
  summarizeSessionActivity,
  type CacheStrategyKey,
  type GapBucketKey,
  type SessionActivity,
} from "./session-activity";

const BUCKET_COPY: Record<GapBucketKey, { label: string; covers: string }> = {
  under5m: { label: "Under 5 min", covers: "a 5m window covers these" },
  under1h: { label: "5 min – 1 h", covers: "a 1h window covers these; 5m needs warm-up" },
  over1h: { label: "Over 1 h", covers: "only warm-up keeps these warm" },
};

const STRATEGY_LABEL: Record<CacheStrategyKey, string> = {
  "5m": "5m, no warm-up",
  "5m-warm": "5m with warm-up",
  "1h": "1h, no warm-up",
  "1h-warm": "1h with warm-up",
};

/** Thin turns would vanish at the strip's scale; this keeps each one a visible sliver. */
const MIN_SEGMENT_SHARE = 0.004;

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function ActivityStrip({ activity }: { activity: SessionActivity }): ReactElement {
  const span = Math.max(1, activity.endMs - activity.startMs);
  return (
    <View style={styles.strip} role="img" aria-label="Active and idle time across the session">
      {activity.segments.map((segment) => (
        <View
          key={`${segment.kind}:${segment.startMs}`}
          style={[
            segment.kind === "active" ? styles.active : styles.idle,
            { flex: Math.max((segment.endMs - segment.startMs) / span, MIN_SEGMENT_SHARE) },
          ]}
        />
      ))}
    </View>
  );
}

function GapBars({ activity }: { activity: SessionActivity }): ReactElement {
  const maxCount = Math.max(1, ...activity.buckets.map((bucket) => bucket.count));
  return (
    <View style={styles.bars} testID="prompt-cache-activity-gaps">
      {activity.buckets.map((bucket) => (
        <View
          key={bucket.key}
          style={styles.barRow}
          testID={`prompt-cache-activity-gap-${bucket.key}`}
        >
          <Text style={styles.barLabel}>{BUCKET_COPY[bucket.key].label}</Text>
          <View style={styles.barTrack}>
            {bucket.count > 0 ? (
              <View style={[styles.barFill, { flex: bucket.count / maxCount }]} />
            ) : null}
            <View style={[styles.barRest, { flex: 1 - bucket.count / maxCount }]} />
          </View>
          <Text style={styles.barValue}>
            {plural(bucket.count, "gap", "gaps")}
            {bucket.count > 0 ? ` · ${formatPreciseDuration(bucket.totalMs)}` : ""}
          </Text>
          <Text style={styles.barHint}>{BUCKET_COPY[bucket.key].covers}</Text>
        </View>
      ))}
    </View>
  );
}

function StrategyCosts({
  requests,
  activity,
  price,
}: {
  requests: readonly PromptCacheHistoryEntry[];
  activity: SessionActivity;
  price: RequestPricer;
}): ReactElement | null {
  const costs = useMemo(
    () => compareCacheStrategies({ requests, gaps: activity.gaps, price }),
    [requests, activity.gaps, price],
  );
  if (activity.gaps.length === 0) return null;
  const lowest = Math.min(...costs.map((cost) => cost.totalUsd));
  return (
    <View style={styles.costs} testID="prompt-cache-activity-costs">
      <Text style={styles.subTitle}>What each window would have cost these gaps (estimate)</Text>
      {costs.map((cost) => (
        <View
          key={cost.key}
          style={styles.costRow}
          testID={`prompt-cache-activity-cost-${cost.key}`}
        >
          <Text style={styles.costLabel}>{STRATEGY_LABEL[cost.key]}</Text>
          <Text style={styles.costCovers}>
            warm for {cost.covered} of {activity.gaps.length}
          </Text>
          <Text style={[styles.costValue, cost.totalUsd === lowest && styles.costLowest]}>
            ≈ {formatUsdEstimate(cost.totalUsd)}
            {cost.totalUsd === lowest ? " · lowest" : ""}
          </Text>
        </View>
      ))}
      <Text style={styles.note}>
        Each return reads the context while it is warm and writes it again once it expired; warm-up
        reads it once per interval up to its cap. New context is written at the price of each
        window. Reads inside a turn cost the same under every window and are left out.
      </Text>
    </View>
  );
}

/**
 * How much of the session was work and how long the gaps between turns were, so the user can see
 * which cache window their own pace needs. Read from the whole journal, not the zoomed range.
 */
export function SessionActivitySection({
  requests,
  sessionRequests,
  busy,
  price,
  nowMs,
}: {
  requests: readonly PromptCacheHistoryEntry[];
  sessionRequests: number | undefined;
  busy: boolean;
  /** Present while money stats are on and the model has a price. */
  price: RequestPricer | null;
  nowMs: number;
}): ReactElement | null {
  const activity = useMemo(
    () => summarizeSessionActivity({ requests, sessionRequests, busy, nowMs }),
    [requests, sessionRequests, busy, nowMs],
  );
  if (!activity) return null;
  const total = Math.max(1, activity.activeMs + activity.idleMs);
  return (
    <View style={styles.section} testID="prompt-cache-activity">
      <Text style={styles.title}>Active and idle time</Text>
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.swatch, styles.active]} />
          <Text style={styles.legendText} testID="prompt-cache-activity-active">
            Active {formatPreciseDuration(activity.activeMs)} ·{" "}
            {Math.round((activity.activeMs / total) * 100)}%
          </Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.swatch, styles.idle]} />
          <Text style={styles.legendText} testID="prompt-cache-activity-idle">
            Idle {formatPreciseDuration(activity.idleMs)} ·{" "}
            {Math.round((activity.idleMs / total) * 100)}%, warm-ups included
          </Text>
        </View>
      </View>
      <ActivityStrip activity={activity} />
      <View style={styles.axis}>
        <Text style={styles.axisText}>{formatClock(activity.startMs)}</Text>
        <Text style={styles.axisText}>{busy ? "now, working" : formatClock(activity.endMs)}</Text>
      </View>
      {activity.partial ? (
        <Text style={styles.note} testID="prompt-cache-activity-partial">
          From {formatClock(activity.startMs)} only: this host started recording the whole session
          after it began, so earlier turns are not shown.
        </Text>
      ) : null}
      <Text style={styles.subTitle}>Gaps between turns</Text>
      <GapBars activity={activity} />
      {activity.ongoingIdleMs > 0 ? (
        <Text style={styles.note}>
          Idle now for {formatPreciseDuration(activity.ongoingIdleMs)}; it counts once the next turn
          starts.
        </Text>
      ) : null}
      {price ? <StrategyCosts requests={requests} activity={activity} price={price} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  section: {
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  subTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    marginTop: theme.spacing[1],
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  legendText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  swatch: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  strip: {
    flexDirection: "row",
    height: 12,
    borderRadius: 3,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
  },
  active: {
    backgroundColor: theme.colors.accent,
  },
  idle: {
    backgroundColor: theme.colors.surface3,
  },
  axis: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  axisText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  bars: {
    gap: theme.spacing[2],
  },
  barRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[2],
    rowGap: 2,
  },
  barLabel: {
    width: 88,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  barTrack: {
    flex: 1,
    minWidth: 80,
    flexDirection: "row",
    height: 12,
  },
  barRest: {
    height: 12,
  },
  barFill: {
    backgroundColor: theme.colors.foregroundMuted,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  barValue: {
    minWidth: 96,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
  barHint: {
    width: "100%",
    paddingLeft: 88 + theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  costs: {
    gap: theme.spacing[1],
  },
  costRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  costLabel: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  costCovers: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  costValue: {
    minWidth: 96,
    textAlign: "right",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
  costLowest: {
    fontWeight: theme.fontWeight.medium,
  },
  note: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
