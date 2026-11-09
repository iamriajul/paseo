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
import { Switch } from "@/components/ui/switch";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import type { AgentCacheWarmPause } from "@getpaseo/protocol/messages";
import { formatCountdownClock, formatPreciseDuration, formatResetTime } from "@/usage/format";
import type { Theme } from "@/styles/theme";
import {
  usePromptCache,
  usePromptCacheAgent,
  type PromptCacheState,
  type PromptCacheStatus,
  type PromptCacheWarmup,
} from "./use-prompt-cache";
import type { PromptCacheHistoryBar, PromptCacheHistorySummary } from "./prompt-cache-history";
import { PromptCacheInsightsDialog } from "./prompt-cache-insights-dialog";
import { WarmUpCapSlider } from "./warm-up-cap-slider";
import { useCountdownFlash } from "./countdown-urgency";
import { useSettings } from "@/hooks/use-settings";
import { formatUsdEstimate } from "./prompt-cache-cost";
import { resolveMoneyStatsPrices } from "./money-stats";
import { resolveNextMessageCost, type NextMessageCost } from "./next-message-cost";
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
      if (
        warmup?.plan.kind === "paused-after-compaction" ||
        warmup?.plan.kind === "paused-account"
      ) {
        return `paused · ${formatCountdownClock(status.remainingMs)}`;
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
    case "paused-after-compaction":
      return "Paused after compacting · resumes on your next message";
    case "paused-account":
      return describeAccountPause(plan.pause);
    case "parent-answers":
      return "Waits for the parent agent";
    case "waits-for-permission":
      return "Paused while awaiting permission";
    case "pauses-question":
      return `Question closes in ${formatCountdownClock(plan.remainingMs)}`;
    case "pauses-permission":
      return `Permission closes in ${formatCountdownClock(plan.remainingMs)}`;
    case "next-ping":
      return `Next in ${formatCountdownClock(plan.remainingMs)}`;
  }
}

/**
 * "Paused · account in cooldown until 17:43 · resumes on your next message". The account cannot
 * take a warm-up, so its cache would expire before it recovers anyway.
 */
export function describeAccountPause(pause: AgentCacheWarmPause, now = Date.now()): string {
  const until = formatResetTime(pause.until, now);
  const when = until ? ` until ${until}` : "";
  const blocked =
    pause.reason === "quota"
      ? `account's ${pause.window ? `${pause.window} ` : ""}quota used up${when}`
      : `account in cooldown${when}`;
  return `Paused · ${blocked} · resumes on your next message`;
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

function resolveMissesText(cache: PromptCacheState): string {
  const count = cache.misses === 1 ? "1 miss" : `${cache.misses} misses`;
  return cache.missesClearedAt
    ? `${count} since cleared · ${cache.sessionMisses} this session`
    : `${count} this session`;
}

function RequestHistory({
  history,
  cache,
}: {
  history: PromptCacheHistorySummary;
  cache: PromptCacheState;
}): ReactElement {
  const { misses, clearMisses } = cache;
  // The clear action sits on the miss count's own row, so it reads as acting on that number.
  const clearable = misses > 0 && clearMisses !== null;
  const missesText = (
    <Text style={[styles.value, misses > 0 && styles.danger]} testID="prompt-cache-history-misses">
      {resolveMissesText(cache)}
    </Text>
  );
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
        {clearable ? null : missesText}
      </View>
      {clearable ? (
        <View style={styles.missesRow}>
          {missesText}
          <Button
            size="sm"
            variant="outline"
            onPress={clearMisses}
            accessibilityLabel="Clear the miss count"
            testID="prompt-cache-clear-misses-button"
          >
            Clear count
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function resolveAutoCompactText(autoCompact: PromptCacheAutoCompact): string {
  if (!autoCompact.enabled) return "Off · the cache expires at the cap";
  const size =
    autoCompact.contextTokens === null
      ? ""
      : ` · ${formatTokenCount(autoCompact.contextTokens)} now`;
  return autoCompact.largeEnough
    ? `On · compacts instead of expiring${size}`
    : `On · from 200k context${size}`;
}

function describeHostDefault(enabled: boolean): string {
  return enabled ? "compact" : "let it expire";
}

/**
 * One labelled switch: the label says what it controls, the line under it what it does now. A
 * switch reads as a setting with a state, where a button labelled with the opposite state did not.
 */
function SwitchRow({
  label,
  status,
  value,
  onValueChange,
  disabled = false,
  testID,
  statusTestID,
}: {
  label: string;
  status: string;
  value: boolean;
  onValueChange: () => void;
  disabled?: boolean;
  testID: string;
  statusTestID: string;
}): ReactElement {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={styles.switchLabel}>{label}</Text>
        <Text style={styles.label} testID={statusTestID}>
          {status}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={label}
        testID={testID}
      />
    </View>
  );
}

function AutoCompactDefault({
  autoCompact,
  onMakeDefault,
}: {
  autoCompact: PromptCacheAutoCompact;
  onMakeDefault: () => void;
}): ReactElement {
  const differs = autoCompact.overridden && autoCompact.enabled !== autoCompact.hostDefault;
  return (
    <View style={styles.defaultRow} testID="prompt-cache-auto-compact-default">
      <Text style={styles.helpTextLeft}>
        {differs
          ? `This agent only · host default: ${describeHostDefault(autoCompact.hostDefault)}`
          : `Host default: ${describeHostDefault(autoCompact.hostDefault)}${autoCompact.overridden ? "" : " · followed"}`}
      </Text>
      {differs ? (
        <Button
          size="sm"
          variant="ghost"
          testID="prompt-cache-auto-compact-make-default"
          onPress={onMakeDefault}
        >
          Make default
        </Button>
      ) : null}
    </View>
  );
}

/**
 * What warm-up costs against what it saves: each warm-up reads the context, the rest of the cap
 * reads it that many times again, and letting it expire writes it all again.
 */
function resolveWarmUpMoneyText(warmup: PromptCacheWarmup, cost: NextMessageCost): string {
  const remaining = Math.max(0, warmup.maxPings - warmup.pingsUsed);
  return `≈ ${formatUsdEstimate(cost.warmUsd)} each · ${formatUsdEstimate(cost.warmUsd * remaining)} to the cap · rewrite ≈ ${formatUsdEstimate(cost.coldUsd)}`;
}

function buildSegments(cache: PromptCacheState, flash: boolean): ComposerTrackPillSegment[] {
  const busy = cache.status.kind === "busy" || cache.status.kind === "busy-expired";
  const segments: ComposerTrackPillSegment[] = [
    { bucket: busy ? ("running" as const) : null, text: resolveSegmentText(cache), flash },
  ];
  if (cache.misses > 0) {
    segments.push({ bucket: null, text: String(cache.misses), tone: "danger" });
  }
  return segments;
}

/** The warm-up cost figures, only while money stats are on and the model has a price. */
function resolveMoneyCost(input: {
  enabled: boolean;
  agent: ReturnType<typeof usePromptCacheAgent>;
  cache: PromptCacheState;
}): NextMessageCost | null {
  if (!input.enabled || !resolveMoneyStatsPrices(input.agent)) return null;
  return resolveNextMessageCost({ agent: input.agent, view: input.cache });
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
  const moneyStats = useSettings((settings) => settings.promptCacheMoneyStats);
  const flash = useCountdownFlash(cache.warmup, cache.now);
  const agent = usePromptCacheAgent(serverId, agentId);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const openInsights = useCallback(() => setInsightsOpen(true), []);
  const closeInsights = useCallback(() => setInsightsOpen(false), []);

  if (!cache.isClaude) {
    return null;
  }

  const { windows, warmup, lastPrompt, history } = cache;
  const segments = buildSegments(cache, flash);
  const canTurnOn = cache.status.kind !== "expired";
  const moneyCost = resolveMoneyCost({ enabled: moneyStats, agent, cache });

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
          {history ? <RequestHistory history={history} cache={cache} /> : null}
          {warmup && windows ? (
            <View style={styles.capBlock}>
              <SwitchRow
                label="Warm-up"
                status={`${resolveWarmupText(warmup)} · ${warmup.pingsUsed}/${warmup.maxPings} · covers ${formatCoveredDuration(warmup, windows)}`}
                value={warmup.enabled}
                onValueChange={cache.toggleWarmup}
                disabled={!warmup.enabled && !canTurnOn}
                testID="prompt-cache-toggle-warmup-switch"
                statusTestID="prompt-cache-cap-count"
              />
              <CapProgress warmup={warmup} />
              {moneyCost && warmup.enabled ? (
                <Text style={styles.label} testID="prompt-cache-warm-up-cost">
                  {resolveWarmUpMoneyText(warmup, moneyCost)}
                </Text>
              ) : null}
              {warmup.enabled && cache.setMaxPings ? (
                <WarmUpCapSlider
                  value={warmup.maxPings}
                  max={warmup.windowMaxPings}
                  coversText={formatPreciseDuration(windows.warmIntervalMs * warmup.maxPings)}
                  onChange={cache.setMaxPings}
                />
              ) : null}
              <View style={styles.switchGroupGap} />
              <SwitchRow
                label="Compact at cap"
                status={resolveAutoCompactText(autoCompact)}
                value={autoCompact.enabled}
                onValueChange={autoCompact.toggle}
                testID="prompt-cache-toggle-auto-compact-switch"
                statusTestID="prompt-cache-auto-compact"
              />
              <AutoCompactDefault
                autoCompact={autoCompact}
                onMakeDefault={autoCompact.makeDefault}
              />
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
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  switchLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  switchGroupGap: {
    height: theme.spacing[2],
  },
  missesRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  defaultRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: 28,
  },
  helpTextLeft: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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
