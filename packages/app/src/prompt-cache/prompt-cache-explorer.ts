import {
  isAvoidablePromptCacheMiss,
  isPromptCacheHit,
  promptCacheInputTokens,
  type PromptCacheCompaction,
  type PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { formatPreciseDuration } from "@/usage/format";
import { formatUsdEstimate } from "./prompt-cache-cost";
import type { RequestPricer } from "./prompt-cache-insights";

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
): { outcome: string; tone: RequestTone } {
  if (entry.gapMs === null) return { outcome: "first write", tone: "neutral" };
  if (entry.afterCompaction) return { outcome: "after compaction", tone: "neutral" };
  if (isPromptCacheHit(entry)) return { outcome: "hit", tone: "hit" };
  if (isAvoidablePromptCacheMiss(entry)) {
    return {
      outcome: entry.gapMs > cacheWindowMs ? "miss · expired" : "miss · dropped while warm",
      tone: "miss",
    };
  }
  return { outcome: "partial", tone: "neutral" };
}

/** One request as the list shows it: what it was, how it met the cache, and what it cost. */
export function describeRequest(input: {
  entry: PromptCacheHistoryEntry;
  price: RequestPricer;
  cacheWindowMs: number;
}): RequestRow {
  const { entry } = input;
  const { outcome, tone } = resolveOutcome(entry, input.cacheWindowMs);
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
  return { at: entry.at, kind: KIND_LABELS[entry.kind], outcome, tone, detail: parts.join(" · ") };
}
