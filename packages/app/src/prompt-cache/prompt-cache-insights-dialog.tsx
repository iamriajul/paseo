import React, { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  FIVE_MINUTE_CACHE_WINDOW_MS,
  type PromptCacheCompaction,
  type PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { formatUsdEstimate } from "./prompt-cache-cost";
import {
  REQUEST_FILTERS,
  describeRequest,
  matchesRequestFilter,
  sliceInsightsRange,
  describeReportedCost,
  type InsightsRange,
  type ReportedCost,
  type RequestFilter,
  type RequestRow,
} from "./prompt-cache-explorer";
import {
  createRequestPricer,
  selectShownRequests,
  summarizePromptCacheInsights,
  type InsightsColumn,
  type InsightsCost,
  type PromptCacheInsights,
  type RequestPricer,
} from "./prompt-cache-insights";
import { usePromptCacheAgent } from "./use-prompt-cache";

const HEADER = { title: "Session cache insights" };
/** Request rows shown before "Show more"; the chart already places every request in time. */
const LIST_PAGE = 30;
/** Compaction rows; a session has few. */
const COMPACTION_LIMIT = 30;

interface InsightsData {
  requests: PromptCacheHistoryEntry[];
  compactions: PromptCacheCompaction[];
}

type InsightsLoad =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: InsightsData };

type ChartMetric = "cache" | "cost";

/** Which bar is selected: its first request and how many requests it stands for. */
interface ColumnKey {
  at: string;
  requests: number;
}

const METRIC_OPTIONS: Array<{ value: ChartMetric; label: string; testID: string }> = [
  { value: "cache", label: "Cache", testID: "prompt-cache-insights-metric-cache" },
  { value: "cost", label: "Cost", testID: "prompt-cache-insights-metric-cost" },
];

const FILTER_OPTIONS = REQUEST_FILTERS.map(({ value, label }) => ({
  value,
  label,
  testID: `prompt-cache-insights-filter-${value}`,
}));

/**
 * The whole session's cache record, fetched from the daemon's journal while the dialog is open.
 * `revision` is the session's request count: a new request refetches, so the view stays live.
 */
function useInsightsLoad(input: {
  serverId: string;
  agentId: string;
  visible: boolean;
  revision: number;
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
  if (!supported) return { kind: "unsupported" };
  if (data) return { kind: "ready", data };
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
  const load = useInsightsLoad({ serverId, agentId, visible, revision });
  const agent = usePromptCacheAgent(serverId, agentId);
  const model = agent?.model ?? agent?.runtimeInfo?.model ?? null;
  const claudeCodeUsd = agent?.lastUsage?.totalCostUsd ?? null;
  const warmUpUsd = agent?.warmUpCostUsd ?? null;
  const reported: ReportedCost = useMemo(
    () => ({ claudeCodeUsd, warmUpUsd }),
    [claudeCodeUsd, warmUpUsd],
  );
  const price = useMemo(
    () =>
      createRequestPricer({
        fallbackModel: model,
        fallbackTtl: cacheWindowMs > FIVE_MINUTE_CACHE_WINDOW_MS ? "1h" : "5m",
      }),
    [model, cacheWindowMs],
  );
  return (
    <AdaptiveModalSheet
      header={HEADER}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={760}
      testID="prompt-cache-insights"
    >
      <InsightsBody load={load} price={price} cacheWindowMs={cacheWindowMs} reported={reported} />
    </AdaptiveModalSheet>
  );
}

function InsightsBody({
  load,
  price,
  cacheWindowMs,
  reported,
}: {
  load: InsightsLoad;
  price: RequestPricer;
  cacheWindowMs: number;
  reported: ReportedCost;
}): ReactElement {
  switch (load.kind) {
    case "loading":
      return <Text style={styles.note}>Loading the session…</Text>;
    case "unsupported":
      return <Text style={styles.note}>Update this host to see the whole session.</Text>;
    case "error":
      return <Text style={styles.note}>{load.message}</Text>;
    case "ready":
      return selectShownRequests(load.data.requests).length === 0 ? (
        <Text style={styles.note}>No requests recorded yet.</Text>
      ) : (
        <InsightsExplorer
          data={load.data}
          price={price}
          cacheWindowMs={cacheWindowMs}
          reported={reported}
        />
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

export function formatSpan(fromIso: string, toIso: string): string {
  const from = formatDayClock(fromIso);
  const sameDay = new Date(fromIso).toDateString() === new Date(toIso).toDateString();
  if (!sameDay) return `${from} – ${formatDayClock(toIso)}`;
  const to = formatClock(toIso);
  // Requests within one minute read as one time, not "1:15 AM – 1:15 AM".
  return to === formatClock(fromIso) ? from : `${from} – ${to}`;
}

export function describeCompaction(compaction: PromptCacheCompaction): string {
  let source = "Claude Code auto-compact";
  if (compaction.atIdleCap) source = "at the warm-up cap";
  else if (compaction.trigger === "manual") source = "/compact";
  return compaction.preTokens === undefined
    ? source
    : `${source} · ${formatTokenCount(compaction.preTokens)} before`;
}

/**
 * The session as something to explore: every figure describes the range on screen, a bar opens
 * its requests below the chart, and zooming into a bar redraws the chart over just those
 * requests, down to one bar per request.
 */
function InsightsExplorer({
  data,
  price,
  cacheWindowMs,
  reported,
}: {
  data: InsightsData;
  price: RequestPricer;
  cacheWindowMs: number;
  reported: ReportedCost;
}): ReactElement {
  const shown = useMemo(() => selectShownRequests(data.requests), [data.requests]);
  const [zoomStack, setZoomStack] = useState<InsightsRange[]>([]);
  // A bar is held by its first request and size, not its index: a live session regroups the
  // columns as requests arrive, and an index would then point at other requests.
  const [selection, setSelection] = useState<ColumnKey | null>(null);
  const [metric, setMetric] = useState<ChartMetric>("cache");
  const [filter, setFilter] = useState<RequestFilter>("all");
  const [limit, setLimit] = useState(LIST_PAGE);

  // A live session grows while the dialog is open; the whole-session range follows it.
  const range = zoomStack.at(-1) ?? { start: 0, end: shown.length };
  const slice = useMemo(
    () => sliceInsightsRange({ shown, compactions: data.compactions, range }),
    // The range is rebuilt every render; its bounds are what decide the slice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, data.compactions, range.start, range.end],
  );
  const insights = useMemo(
    () =>
      summarizePromptCacheInsights({
        requests: slice.requests,
        compactions: slice.compactions,
        cacheWindowMs,
        price,
        nowMs: Date.now(),
      }),
    [slice, cacheWindowMs, price],
  );
  // Cost over the whole session also counts the requests left out of the chart.
  const sessionCost = useMemo(
    () =>
      zoomStack.length === 0
        ? summarizePromptCacheInsights({
            requests: data.requests,
            compactions: data.compactions,
            cacheWindowMs,
            price,
            nowMs: Date.now(),
          }).cost
        : insights.cost,
    [zoomStack.length, data, cacheWindowMs, price, insights.cost],
  );

  const selectedIndex = selection
    ? insights.columns.findIndex(
        (column) => column.at === selection.at && column.requests === selection.requests,
      )
    : -1;
  const selected = selectedIndex === -1 ? null : selectedIndex;
  const selectedColumn = selected === null ? null : (insights.columns[selected] ?? null);
  const listRequests = selectedColumn
    ? slice.requests.slice(selectedColumn.startIndex, selectedColumn.endIndex)
    : slice.requests;
  const filtered = listRequests.filter((entry) => matchesRequestFilter(entry, filter)).toReversed();

  const resetSelection = useCallback(() => {
    setSelection(null);
    setLimit(LIST_PAGE);
  }, []);
  const columns = insights.columns;
  const selectColumn = useCallback(
    (index: number) => {
      const column = columns[index];
      if (!column) return;
      setSelection((current) =>
        current?.at === column.at && current.requests === column.requests
          ? null
          : { at: column.at, requests: column.requests },
      );
      setLimit(LIST_PAGE);
    },
    [columns],
  );
  const zoomIn = useCallback(() => {
    if (!selectedColumn) return;
    const start = range.start + selectedColumn.startIndex;
    setZoomStack((stack) => [...stack, { start, end: start + selectedColumn.requests }]);
    resetSelection();
  }, [selectedColumn, range.start, resetSelection]);
  const zoomOut = useCallback(() => {
    setZoomStack((stack) => stack.slice(0, -1));
    resetSelection();
  }, [resetSelection]);
  const zoomReset = useCallback(() => {
    setZoomStack([]);
    resetSelection();
  }, [resetSelection]);
  const changeFilter = useCallback((next: RequestFilter) => {
    setFilter(next);
    setLimit(LIST_PAGE);
  }, []);
  const showMore = useCallback(() => setLimit((current) => current + LIST_PAGE), []);
  const clearSelection = useCallback(() => setSelection(null), []);

  const misses = insights.missesAfterExpiry + insights.missesWhileWarm;
  return (
    <View style={styles.content}>
      <RangeBar
        insights={insights}
        zoomed={zoomStack.length > 0}
        depth={zoomStack.length}
        onZoomOut={zoomOut}
        onReset={zoomReset}
      />
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
      <CostSplit cost={sessionCost} reported={zoomStack.length === 0 ? reported : null} />
      <View style={styles.chartHeader}>
        <Text style={styles.sectionTitle}>
          {metric === "cache" ? "How each request met the cache" : "Estimated input cost"}
        </Text>
        <SegmentedControl
          options={METRIC_OPTIONS}
          value={metric}
          onValueChange={setMetric}
          size="xs"
          testID="prompt-cache-insights-metric"
        />
      </View>
      <SessionChart
        insights={insights}
        metric={metric}
        selected={selected}
        onSelect={selectColumn}
      />
      {selectedColumn ? (
        <ColumnDetail
          column={selectedColumn}
          requests={listRequests}
          onZoomIn={zoomIn}
          onClear={clearSelection}
        />
      ) : null}
      <View style={styles.section}>
        <View style={styles.chartHeader}>
          <Text style={styles.sectionTitle}>
            {selectedColumn ? "Requests in the selected bar" : "Requests"} · {filtered.length}
          </Text>
          <SegmentedControl
            options={FILTER_OPTIONS}
            value={filter}
            onValueChange={changeFilter}
            size="xs"
            testID="prompt-cache-insights-filter"
          />
        </View>
        {filtered.length === 0 ? <Text style={styles.note}>None in this range.</Text> : null}
        {filtered.slice(0, limit).map((entry) => (
          <RequestListRow
            key={`${entry.at}-${entry.kind}`}
            row={describeRequest({ entry, price, cacheWindowMs })}
          />
        ))}
        {filtered.length > limit ? (
          <Button
            size="sm"
            variant="ghost"
            onPress={showMore}
            testID="prompt-cache-insights-show-more"
          >
            {`Show ${Math.min(LIST_PAGE, filtered.length - limit)} more of ${filtered.length - limit}`}
          </Button>
        ) : null}
      </View>
      {insights.compactions.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Compactions</Text>
          {insights.compactions.slice(0, COMPACTION_LIMIT).map((compaction) => (
            <View key={compaction.at} style={styles.listRow}>
              <Text style={styles.listTime}>{formatClock(compaction.at)}</Text>
              <Text style={styles.listText}>{describeCompaction(compaction)}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text style={styles.note}>
        Written {formatTokenCount(insights.writeTokens)} · read{" "}
        {formatTokenCount(insights.readTokens)} · peak context{" "}
        {formatTokenCount(insights.peakContextTokens)}. A miss is a request that did not read at
        least 90% of the context the previous request left in the cache. The first request of a
        fresh session cannot hit; the first request of a native fork is measured against the context
        it inherited. The first request after a compaction is left out of every count and chart; the
        compaction marks the chart instead. Costs are input at Anthropic API list prices, main
        thread only: output and subagents are not recorded per request.
      </Text>
    </View>
  );
}

function RangeBar({
  insights,
  zoomed,
  depth,
  onZoomOut,
  onReset,
}: {
  insights: PromptCacheInsights;
  zoomed: boolean;
  depth: number;
  onZoomOut: () => void;
  onReset: () => void;
}): ReactElement {
  const span =
    insights.firstAt && insights.lastAt ? formatSpan(insights.firstAt, insights.lastAt) : "";
  return (
    <View style={styles.rangeBar} testID="prompt-cache-insights-range">
      <View style={styles.rangeText}>
        <Text style={styles.sectionTitle}>{zoomed ? "Zoomed in" : "Whole session"}</Text>
        <Text style={styles.note}>{span}</Text>
      </View>
      {zoomed ? (
        <View style={styles.rangeActions}>
          {depth > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={onZoomOut}
              testID="prompt-cache-insights-zoom-out"
            >
              Zoom out
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onPress={onReset}
            testID="prompt-cache-insights-zoom-reset"
          >
            Whole session
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function CostSplit({
  cost,
  reported,
}: {
  cost: InsightsCost;
  reported: ReportedCost | null;
}): ReactElement | null {
  const total = cost.warmUpUsd + cost.workUsd;
  if (total <= 0) return null;
  const warmShare = cost.warmUpUsd / total;
  const { payback } = cost;
  const stretches = payback.kept + payback.lapsed;
  return (
    <View style={styles.section} testID="prompt-cache-insights-cost">
      <Text style={styles.sectionTitle}>Where the input cost went (estimate)</Text>
      <View style={styles.splitTrack}>
        <View style={[styles.splitWork, { flex: Math.max(1 - warmShare, 0.0001) }]} />
        {warmShare > 0 ? <View style={[styles.splitWarm, { flex: warmShare }]} /> : null}
      </View>
      <View style={styles.splitLegend}>
        <LegendSwatch
          style={styles.splitWork}
          label={`Work ${formatUsdEstimate(cost.workUsd)} · ${formatPercent(1 - warmShare)}`}
        />
        <LegendSwatch
          style={styles.splitWarm}
          label={`Warm-ups ${formatUsdEstimate(cost.warmUpUsd)} · ${formatPercent(warmShare)}`}
        />
      </View>
      {stretches > 0 || payback.ongoing ? (
        <Text style={styles.listText} testID="prompt-cache-insights-payback">
          {describePayback(cost)}
        </Text>
      ) : null}
      {reported && describeReportedCost(reported) ? (
        <Text style={styles.note} testID="prompt-cache-insights-reported-cost">
          {describeReportedCost(reported)}
        </Text>
      ) : null}
      {cost.unpriced > 0 ? (
        <Text style={styles.note}>
          {cost.unpriced} {cost.unpriced === 1 ? "request" : "requests"} on a model with no known
          price left out.
        </Text>
      ) : null}
    </View>
  );
}

export function describePayback(cost: InsightsCost): string {
  const { payback } = cost;
  const parts: string[] = [];
  if (payback.kept > 0) {
    parts.push(
      `Warm-ups kept the cache for ${payback.kept} ${payback.kept === 1 ? "return" : "returns"}, saving ≈ ${formatUsdEstimate(payback.savedUsd)} of rewrites`,
    );
  }
  if (payback.lapsed > 0) {
    parts.push(
      `${payback.lapsed} idle ${payback.lapsed === 1 ? "stretch" : "stretches"} lapsed with no warm return (${formatUsdEstimate(payback.lapsedUsd)} spent)`,
    );
  }
  if (payback.ongoing) parts.push("one stretch is still warm");
  return `${parts.join("; ")}.`;
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

const SELECTED_STATE = { selected: true };
const UNSELECTED_STATE = { selected: false };

function resolveColumnFill(column: InsightsColumn) {
  if (column.missed) return styles.fillMiss;
  return column.hit ? styles.fillHit : styles.fillCold;
}

function ChartColumn({
  column,
  index,
  metric,
  maxCostUsd,
  selected,
  dimmed,
  onSelect,
}: {
  column: InsightsColumn;
  index: number;
  metric: ChartMetric;
  maxCostUsd: number;
  selected: boolean;
  dimmed: boolean;
  onSelect: (index: number) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(index), [onSelect, index]);
  const label = `${formatClock(column.at)}, ${column.requests} ${column.requests === 1 ? "request" : "requests"}, ${formatPercent(column.ratio)} read from cache, ${formatUsdEstimate(column.costUsd)}`;
  return (
    <PressHighlight
      style={[styles.column, dimmed && styles.columnDimmed]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      testID={`prompt-cache-insights-column-${index}`}
    >
      <View style={[styles.columnTrack, selected && styles.columnTrackSelected]}>
        {metric === "cache" ? (
          <View
            style={[
              styles.columnFill,
              resolveColumnFill(column),
              { height: `${Math.round(Math.max(column.ratio, 0.06) * 100)}%` },
            ]}
          />
        ) : (
          <CostFill column={column} maxCostUsd={maxCostUsd} />
        )}
      </View>
      <View style={[styles.compactionMark, column.compacted && styles.compactionMarkOn]} />
    </PressHighlight>
  );
}

function CostFill({
  column,
  maxCostUsd,
}: {
  column: InsightsColumn;
  maxCostUsd: number;
}): ReactElement {
  const share = maxCostUsd > 0 ? column.costUsd / maxCostUsd : 0;
  const height = Math.max(share, column.costUsd > 0 ? 0.04 : 0);
  const warmShare = column.costUsd > 0 ? column.warmUpCostUsd / column.costUsd : 0;
  return (
    <View style={[styles.costStack, { height: `${Math.round(height * 100)}%` }]}>
      {warmShare > 0 ? <View style={[styles.splitWarm, { flex: warmShare }]} /> : null}
      <View
        style={[
          column.missed ? styles.fillMiss : styles.splitWork,
          { flex: Math.max(1 - warmShare, 0.0001) },
        ]}
      />
    </View>
  );
}

function SessionChart({
  insights,
  metric,
  selected,
  onSelect,
}: {
  insights: PromptCacheInsights;
  metric: ChartMetric;
  selected: number | null;
  onSelect: (index: number) => void;
}): ReactElement {
  const perColumn = insights.columns[0]?.requests ?? 1;
  const maxCostUsd = useMemo(
    () => insights.columns.reduce((max, column) => Math.max(max, column.costUsd), 0),
    [insights.columns],
  );
  return (
    <View style={styles.chartBlock}>
      <View
        style={styles.chart}
        role="group"
        aria-label={`${insights.requests} requests, ${formatPercent(insights.cachedShare)} of input from cache`}
        testID="prompt-cache-insights-chart"
      >
        {insights.columns.map((column, index) => (
          <ChartColumn
            key={column.at}
            column={column}
            index={index}
            metric={metric}
            maxCostUsd={maxCostUsd}
            selected={selected === index}
            dimmed={selected !== null && selected !== index}
            onSelect={onSelect}
          />
        ))}
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisText}>
          {insights.firstAt ? formatDayClock(insights.firstAt) : ""}
        </Text>
        <Text style={styles.axisText}>
          {insights.lastAt ? formatDayClock(insights.lastAt) : ""}
        </Text>
      </View>
      {/* Its own line: beside the two dates it overflowed a phone's width. */}
      <Text style={styles.axisText}>
        {perColumn > 1
          ? `Each bar is ${perColumn} requests. Tap one to inspect it.`
          : "Each bar is a request. Tap one to inspect it."}
      </Text>
      <View style={styles.legend}>
        {metric === "cache" ? (
          <>
            <LegendSwatch style={styles.fillHit} label="Read from cache" />
            <LegendSwatch style={styles.fillMiss} label="Miss" />
            <LegendSwatch style={styles.fillCold} label="First write" />
          </>
        ) : (
          <>
            <LegendSwatch style={styles.splitWork} label="Work" />
            <LegendSwatch style={styles.splitWarm} label="Warm-ups" />
            <LegendSwatch style={styles.fillMiss} label="Contains a miss" />
          </>
        )}
        <LegendSwatch style={styles.compactionMarkOn} label="Compaction" />
      </View>
    </View>
  );
}

function ColumnDetail({
  column,
  requests,
  onZoomIn,
  onClear,
}: {
  column: InsightsColumn;
  requests: readonly PromptCacheHistoryEntry[];
  onZoomIn: () => void;
  onClear: () => void;
}): ReactElement {
  const warmUps = requests.filter((entry) => entry.kind === "warm-up").length;
  const missCount = requests.filter((entry) => matchesRequestFilter(entry, "misses")).length;
  const span = formatSpan(column.at, column.endAt);
  const facts = [
    `${column.requests} ${column.requests === 1 ? "request" : "requests"}`,
    `${formatPercent(column.ratio)} read from cache`,
    ...(missCount > 0 ? [`${missCount} ${missCount === 1 ? "miss" : "misses"}`] : []),
    ...(warmUps > 0 ? [`${warmUps} ${warmUps === 1 ? "warm-up" : "warm-ups"}`] : []),
    `${formatTokenCount(column.contextTokens)} context`,
    `≈ ${formatUsdEstimate(column.costUsd)}`,
  ];
  return (
    <View style={styles.columnDetail} testID="prompt-cache-insights-selection">
      <View style={styles.rangeText}>
        <Text style={styles.sectionTitle}>{span}</Text>
        <Text style={styles.note}>{facts.join(" · ")}</Text>
      </View>
      <View style={styles.rangeActions}>
        {column.requests > 1 ? (
          <Button
            size="sm"
            variant="outline"
            onPress={onZoomIn}
            testID="prompt-cache-insights-zoom-in"
          >
            Zoom in
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onPress={onClear} testID="prompt-cache-insights-clear">
          Clear
        </Button>
      </View>
    </View>
  );
}

function RequestListRow({ row }: { row: RequestRow }): ReactElement {
  return (
    <View style={styles.listRow}>
      <Text style={[styles.listTime, row.tone === "miss" && styles.danger]}>
        {formatClock(row.at)}
      </Text>
      <View style={styles.listBody}>
        <Text style={styles.listText}>
          <Text style={styles.listKind}>{row.kind}</Text>
          <Text
            style={[
              styles.listOutcome,
              row.tone === "hit" && styles.success,
              row.tone === "miss" && styles.danger,
            ]}
          >
            {" "}
            · {row.outcome}
          </Text>
        </Text>
        <Text style={styles.note}>{row.detail}</Text>
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
  success: {
    color: theme.colors.statusSuccess,
  },
  rangeBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rangeText: {
    flex: 1,
    gap: 2,
  },
  rangeActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  chartHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
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
  columnDimmed: {
    opacity: 0.45,
  },
  columnTrack: {
    height: 100,
    borderRadius: 1,
    backgroundColor: theme.colors.surface3,
    justifyContent: "flex-end",
    overflow: "hidden",
  },
  columnTrackSelected: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foreground,
  },
  columnFill: {
    width: "100%",
  },
  costStack: {
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
  splitTrack: {
    flexDirection: "row",
    height: 10,
    borderRadius: 3,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
  },
  splitWork: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  // Amber, the warm-up flame's color.
  splitWarm: {
    backgroundColor: theme.colors.statusWarning,
  },
  splitLegend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
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
  columnDetail: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  listRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  listBody: {
    flex: 1,
    gap: 2,
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
  listKind: {
    fontWeight: theme.fontWeight.medium,
  },
  listOutcome: {
    color: theme.colors.foregroundMuted,
  },
}));
