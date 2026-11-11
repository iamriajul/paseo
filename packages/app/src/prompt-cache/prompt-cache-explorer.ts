import {
  isAvoidablePromptCacheMiss,
  isPromptCacheHit,
  promptCacheInputTokens,
  type CacheWarmStop,
  type GatewayAccountChange,
  type PromptCacheCompaction,
  type PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { formatPreciseDuration } from "@/usage/format";
import { formatUsdEstimate } from "./prompt-cache-cost";
import type { RequestPricer } from "./prompt-cache-insights";
import { describeWarmUpStop } from "./warm-up-stop";

/** A run of shown requests, by index: the whole session, or a column zoomed into. */
export interface InsightsRange {
  start: number;
  end: number;
}

export type RequestFilter = "all" | "misses" | "warm-ups" | "turns";

export const REQUEST_FILTERS: ReadonlyArray<{ value: RequestFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "misses", label: "Misses" },
  { value: "warm-ups", label: "Warm-ups" },
  { value: "turns", label: "Turns" },
];

export function matchesRequestFilter(
  entry: PromptCacheHistoryEntry,
  filter: RequestFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "misses":
      return isAvoidablePromptCacheMiss(entry);
    case "warm-ups":
      return entry.kind === "warm-up";
    case "turns":
      return entry.kind === "turn";
  }
}

/**
 * The requests and compactions of one range. Compactions are kept when they landed after the
 * request before the range and by the range's last request, the same rule the chart marks by.
 */
export function sliceInsightsRange(input: {
  shown: readonly PromptCacheHistoryEntry[];
  compactions: readonly PromptCacheCompaction[];
  range: InsightsRange;
}): { requests: PromptCacheHistoryEntry[]; compactions: PromptCacheCompaction[] } {
  const { shown, range } = input;
  const requests = shown.slice(range.start, range.end);
  const afterAt = shown[range.start - 1]?.at ?? null;
  const isLast = range.end >= shown.length;
  const lastAt = requests.at(-1)?.at ?? "";
  return {
    requests,
    compactions: input.compactions.filter(
      (compaction) =>
        (afterAt === null || compaction.at > afterAt) && (isLast || compaction.at <= lastAt),
    ),
  };
}

const KIND_LABELS: Record<PromptCacheHistoryEntry["kind"], string> = {
  turn: "Turn",
  request: "Tool step",
  "warm-up": "Warm-up",
};

export type RequestTone = "hit" | "miss" | "neutral";

export interface RequestRow {
  at: string;
  kind: string;
  outcome: string;
  tone: RequestTone;
  detail: string;
}

function resolveOutcome(
  entry: PromptCacheHistoryEntry,
  cacheWindowMs: number,
  switched: GatewayAccountChange | undefined,
): { outcome: string; tone: RequestTone } {
  if (entry.gapMs === null) return { outcome: "first write", tone: "neutral" };
  if (entry.afterCompaction) return { outcome: "after compaction", tone: "neutral" };
  if (isPromptCacheHit(entry)) return { outcome: "hit", tone: "hit" };
  if (isAvoidablePromptCacheMiss(entry)) {
    // An expired cache was gone whichever account served the request, so expiry is the cause.
    if (entry.gapMs > cacheWindowMs) return { outcome: "miss · expired", tone: "miss" };
    if (switched) return { outcome: "miss · account switched", tone: "miss" };
    return { outcome: "miss · dropped while warm", tone: "miss" };
  }
  return { outcome: "partial", tone: "neutral" };
}

/** "switched A → B (quota, 429)": the CLIProxyAPI move that cost the cache. */
export function describeAccountSwitch(change: GatewayAccountChange): string {
  const cause = [change.reason, change.statusCode].filter(Boolean).join(", ");
  const accounts = change.from ? `${change.from} → ${change.account}` : change.account;
  return cause ? `switched ${accounts} (${cause})` : `switched ${accounts}`;
}

/** The account change each missed request was charged to, keyed by the request's `at`. */
export function indexSwitchMisses(
  accounts: readonly GatewayAccountChange[],
): ReadonlyMap<string, GatewayAccountChange> {
  return new Map(
    accounts.flatMap((change) => (change.missAt ? [[change.missAt, change] as const] : [])),
  );
}

/** One request as the list shows it: what it was, how it met the cache, and what it cost. */
export function describeRequest(input: {
  entry: PromptCacheHistoryEntry;
  price: RequestPricer;
  cacheWindowMs: number;
  /** The CLIProxyAPI account switch charged with this request's miss, if any. */
  switchedAccount?: GatewayAccountChange;
  /** Why the warm-up let the cache expire before this request, when the host journaled it. */
  warmUpStop?: CacheWarmStop;
}): RequestRow {
  const { entry } = input;
  const { outcome, tone } = resolveOutcome(entry, input.cacheWindowMs, input.switchedAccount);
  const parts = [
    `${formatTokenCount(promptCacheInputTokens(entry))} context`,
    `read ${formatTokenCount(entry.readTokens)}`,
    `wrote ${formatTokenCount(entry.writeTokens)}`,
  ];
  // A turn's time away says more than the gap to a warm-up that kept it.
  const gapMs = entry.kind === "turn" ? (entry.awayMs ?? entry.gapMs) : entry.gapMs;
  if (gapMs !== null && gapMs >= 1_000) parts.push(`after ${formatPreciseDuration(gapMs)}`);
  const usd = input.price(entry);
  if (usd !== null) parts.push(`≈ ${formatUsdEstimate(usd)}`);
  if (entry.model) parts.push(entry.model.replace(/^claude-/, ""));
  if (outcome === "miss · account switched" && input.switchedAccount) {
    parts.unshift(describeAccountSwitch(input.switchedAccount));
  }
  if (outcome === "miss · expired" && input.warmUpStop) {
    parts.unshift(describeWarmUpStop(input.warmUpStop));
  }
  return { at: entry.at, kind: KIND_LABELS[entry.kind], outcome, tone, detail: parts.join(" · ") };
}

/** The session cost the agent reports: Claude Code's own figure, and the priced warm-ups. */
export interface ReportedCost {
  claudeCodeUsd: number | null;
  warmUpUsd: number | null;
}

export function describeReportedCost(reported: ReportedCost): string | null {
  const { claudeCodeUsd, warmUpUsd } = reported;
  if (claudeCodeUsd === null && warmUpUsd === null) return null;
  const parts: string[] = [];
  if (claudeCodeUsd !== null)
    parts.push(`Claude Code reported ${formatUsdEstimate(claudeCodeUsd)}`);
  if (warmUpUsd !== null) parts.push(`warm-ups ≈ ${formatUsdEstimate(warmUpUsd)}`);
  const total = (claudeCodeUsd ?? 0) + (warmUpUsd ?? 0);
  const sum = parts.length > 1 ? ` · ${formatUsdEstimate(total)} in all` : "";
  // Only a fork warm-up (v2) has a priced cost of its own; a ping warm-up is a turn Claude Code counts.
  const counts =
    warmUpUsd === null
      ? "counts output and subagents"
      : "counts output and subagents but not fork warm-ups";
  return `Session cost: ${parts.join(" + ")}${sum}. Claude Code's figure ${counts}; the split above is an input estimate from the request journal.`;
}
