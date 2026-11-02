import React, { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  PromptCacheCompaction,
  PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { formatPreciseDuration } from "@/usage/format";
import type { Theme } from "@/styles/theme";
import {
  summarizePromptCacheInsights,
  type InsightsColumn,
  type InsightsMiss,
  type PromptCacheInsights,
} from "./prompt-cache-insights";

const HEADER = { title: "Session cache insights" };
/** Rows each list shows; the chart already places every one of them in time. */
const LIST_LIMIT = 30;

interface InsightsData {
  requests: PromptCacheHistoryEntry[];
  compactions: PromptCacheCompaction[];
}

type InsightsLoad =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ready"; insights: PromptCacheInsights };

/**
 * The whole session's cache record, fetched from the daemon's journal while the dialog is open.
 * `revision` is the session's request count: a new request refetches, so the view stays live.
 */
function useInsightsLoad(input: {
  serverId: string;
  agentId: string;
  visible: boolean;
  revision: number;
  cacheWindowMs: number;
}): InsightsLoad {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  const supported = useHostFeature(input.serverId, "promptCacheInsights");
  const query = useFetchQuery<InsightsData, Error>({
    queryKey: ["promptCacheInsights", input.serverId, input.agentId, input.revision],
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const payload = await client.getPromptCacheHistory({ agentId: input.agentId });
      if (payload.error) throw new Error(payload.error);
      return { requests: payload.requests, compactions: payload.compactions };
    },
    enabled: Boolean(input.visible && client && supported),
    retry: false,
    dataShape: "value",
    // The key carries the request count, so a new request refetches; this only spares a
    // reopen within the same minute.
    staleTimeMs: 60_000,
  });
  // A new request changes the key, so keep the last session on screen until its data arrives.
  const [shown, setShown] = useState<InsightsData | null>(null);
  useEffect(() => {
    if (query.data) setShown(query.data);
  }, [query.data]);
  const data = query.data ?? shown;
  const insights = useMemo(
    () =>
      data
        ? summarizePromptCacheInsights({
            requests: data.requests,
            compactions: data.compactions,
            cacheWindowMs: input.cacheWindowMs,
          })
        : null,
    [data, input.cacheWindowMs],
  );
  if (!supported) return { kind: "unsupported" };
  if (insights) return { kind: "ready", insights };
  if (query.isError) return { kind: "error", message: query.error.message };
  return { kind: "loading" };
}

export function PromptCacheInsightsDialog({
  serverId,
  agentId,
  visible,
  onClose,
  revision,
  cacheWindowMs,
}: {
  serverId: string;
  agentId: string;
  visible: boolean;
  onClose: () => void;
  revision: number;
  cacheWindowMs: number;
}): ReactElement {
  const load = useInsightsLoad({ serverId, agentId, visible, revision, cacheWindowMs });
  return (
    <AdaptiveModalSheet
      header={HEADER}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={760}
      testID="prompt-cache-insights"
    >
      <InsightsBody load={load} />
    </AdaptiveModalSheet>
  );
}

function InsightsBody({ load }: { load: InsightsLoad }): ReactElement {
  switch (load.kind) {
    case "loading":
      return <Text style={styles.note}>Loading the session…</Text>;
    case "unsupported":
      return <Text style={styles.note}>Update this host to see the whole session.</Text>;
    case "error":
      return <Text style={styles.note}>{load.message}</Text>;
    case "ready":
      return load.insights.columns.length === 0 ? (
        <Text style={styles.note}>No requests recorded yet.</Text>
      ) : (
        <InsightsContent insights={load.insights} />
      );
  }
}

function formatPercent(fraction: number): string {
  return `${Math.floor(fraction * 100)}%`;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDayClock(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const MISS_KIND_LABELS: Record<InsightsMiss["kind"], string> = {
  turn: "turn",
  request: "inside a turn",
  "warm-up": "warm-up",
};

export function describeMiss(miss: InsightsMiss): string {
  const where = MISS_KIND_LABELS[miss.kind];
  const gap = miss.gapMs === null ? "" : ` after ${formatPreciseDuration(miss.gapMs)}`;
  const cause = miss.afterExpiry ? "expired" : "warm cache dropped";
  return `${where}${gap} · ${cause} · wrote ${formatTokenCount(miss.writeTokens)}`;
}

export function describeCompaction(compaction: PromptCacheCompaction): string {
  let source = "Claude Code auto-compact";
  if (compaction.atIdleCap) source = "at the warm-up cap";
  else if (compaction.trigger === "manual") source = "/compact";
  return compaction.preTokens === undefined
    ? source
    : `${source} · ${formatTokenCount(compaction.preTokens)} before`;
}

function InsightsContent({ insights }: { insights: PromptCacheInsights }): ReactElement {
  const misses = insights.missesAfterExpiry + insights.missesWhileWarm;
  return (
    <View style={styles.content}>
      <View style={styles.tiles}>
        <Tile label="Requests" value={String(insights.requests)} />
        <Tile
          label="Hit rate"
          value={insights.requests > 0 ? formatPercent(insights.hits / insights.requests) : "—"}
          testID="prompt-cache-insights-hit-rate"
        />
        <Tile label="Input from cache" value={formatPercent(insights.cachedShare)} />
        <Tile
          label="Misses"
          value={String(misses)}
          danger={misses > 0}
          testID="prompt-cache-insights-misses"
        />
        <Tile label="Warm-ups" value={String(insights.warmUps)} />
        <Tile label="Compactions" value={String(insights.compactions.length)} />
      </View>
      <SessionChart insights={insights} />
      {misses > 0 ? (
        <Section
          title={`Misses · ${insights.missesAfterExpiry} expired · ${insights.missesWhileWarm} while warm`}
        >
          {insights.misses.slice(0, LIST_LIMIT).map((miss) => (
            <ListRow key={miss.at} at={miss.at} text={describeMiss(miss)} danger />
          ))}
        </Section>
      ) : null}
      {insights.compactions.length > 0 ? (
        <Section title="Compactions">
          {insights.compactions.slice(0, LIST_LIMIT).map((compaction) => (
            <ListRow key={compaction.at} at={compaction.at} text={describeCompaction(compaction)} />
          ))}
        </Section>
      ) : null}
      <Text style={styles.note}>
        Written {formatTokenCount(insights.writeTokens)} · read{" "}
        {formatTokenCount(insights.readTokens)} · peak context{" "}
        {formatTokenCount(insights.peakContextTokens)}. A miss is a request that did not read at
        least 90% of the context the previous request left in the cache. Text it appended is
        written, not read, so it is not a miss. The first request of a session cannot hit, so it is
        neither a hit nor a miss. The first request after a compaction is left out of every count
        and chart; the compaction marks the chart instead. Bar height is the share of input read.
      </Text>
    </View>
  );
}

function Tile({
  label,
  value,
  danger = false,
  testID,
}: {
  label: string;
  value: string;
  danger?: boolean;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, danger && styles.danger]} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

function resolveColumnFill(column: InsightsColumn) {
  if (column.missed) return styles.fillMiss;
  return column.hit ? styles.fillHit : styles.fillCold;
}

function ChartColumn({ column }: { column: InsightsColumn }): ReactElement {
  const height = `${Math.round(Math.max(column.ratio, 0.06) * 100)}%` as const;
  return (
    <View style={styles.column}>
      <View style={styles.columnTrack}>
        <View style={[styles.columnFill, resolveColumnFill(column), { height }]} />
      </View>
      <View style={[styles.compactionMark, column.compacted && styles.compactionMarkOn]} />
    </View>
  );
}

function SessionChart({ insights }: { insights: PromptCacheInsights }): ReactElement {
  const perColumn = insights.columns[0]?.requests ?? 1;
  return (
    <View style={styles.chartBlock}>
      <View
        style={styles.chart}
        role="img"
        aria-label={`${insights.requests} requests, ${formatPercent(insights.cachedShare)} of input from cache`}
        testID="prompt-cache-insights-chart"
      >
        {insights.columns.map((column) => (
          <ChartColumn key={column.at} column={column} />
        ))}
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisText}>
          {insights.firstAt ? formatDayClock(insights.firstAt) : ""}
        </Text>
        <Text style={styles.axisText}>
          {perColumn > 1 ? `each bar is ${perColumn} requests` : "each bar is a request"}
        </Text>
        <Text style={styles.axisText}>
          {insights.lastAt ? formatDayClock(insights.lastAt) : ""}
        </Text>
      </View>
      <View style={styles.legend}>
        <LegendSwatch style={styles.fillHit} label="Read from cache" />
        <LegendSwatch style={styles.fillMiss} label="Miss" />
        <LegendSwatch style={styles.fillCold} label="First write" />
        <LegendSwatch style={styles.compactionMarkOn} label="Compaction" />
      </View>
    </View>
  );
}

function LegendSwatch({ style, label }: { style: object; label: string }): ReactElement {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.swatch, style]} />
      <Text style={styles.axisText}>{label}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ListRow({ at, text, danger = false }: { at: string; text: string; danger?: boolean }) {
  return (
    <View style={styles.listRow}>
      <Text style={[styles.listTime, danger && styles.danger]}>{formatClock(at)}</Text>
      <Text style={styles.listText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  content: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  note: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tiles: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  tile: {
    flexGrow: 1,
    flexBasis: 100,
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  tileLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tileValue: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  danger: {
    color: theme.colors.statusDanger,
  },
  chartBlock: {
    gap: theme.spacing[2],
  },
  chart: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 1,
    height: 112,
  },
  column: {
    flex: 1,
    maxWidth: 20,
    gap: 3,
  },
  columnTrack: {
    height: 100,
    borderRadius: 1,
    backgroundColor: theme.colors.surface3,
    justifyContent: "flex-end",
    overflow: "hidden",
  },
  columnFill: {
    width: "100%",
  },
  fillHit: {
    backgroundColor: theme.colors.statusSuccess,
  },
  fillMiss: {
    backgroundColor: theme.colors.statusDanger,
  },
  fillCold: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  compactionMark: {
    height: 6,
    borderRadius: 3,
  },
  // Purple keeps it apart from the hit green and the warm-up amber.
  compactionMarkOn: {
    backgroundColor: theme.colors.statusMerged,
  },
  axis: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  axisText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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
  swatch: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  section: {
    gap: theme.spacing[1],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[1],
  },
  listRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  listTime: {
    width: 72,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  listText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
