import {
  promptCacheHitRatio,
  type PromptCacheHistoryEntry,
  type PromptCacheRequestKind,
} from "@getpaseo/protocol/agent-cache-warm";

/**
 * A request counts as a hit when most of its input came from the cache. An expired cache can
 * still read a small shared prefix, so "any read" would call a real miss a hit.
 */
const HIT_RATIO = 0.5;

export interface PromptCacheHistoryBar {
  at: string;
  kind: PromptCacheRequestKind;
  /** Cached share of the request's input, 0 when it recorded no input. */
  ratio: number;
  hit: boolean;
  /**
   * More than the cache window passed since the previous request (or there was none), so the
   * cache could not still be alive. A miss without it means something else invalidated it.
   */
  afterExpiry: boolean;
  /** A turn started after longer than the cache window away; null otherwise. */
  awayMs: number | null;
}

export interface PromptCacheHitCount {
  hit: number;
  total: number;
}

export interface PromptCacheLastReturn {
  awayMs: number;
  warmUps: number;
  hit: boolean;
  ratio: number;
}

export interface PromptCacheHistorySummary {
  bars: PromptCacheHistoryBar[];
  requests: PromptCacheHitCount;
  /** Read tokens over all input tokens: how much of the input was billed at the cache price. */
  cachedShare: number;
  /** Turns started after longer than the cache window away, where only warm-ups kept it. */
  returns: PromptCacheHitCount;
  warmUps: PromptCacheHitCount;
  missesAfterExpiry: number;
  missesWhileWarm: number;
  lastReturn: PromptCacheLastReturn | null;
}

function countHits(bars: PromptCacheHistoryBar[]): PromptCacheHitCount {
  return { hit: bars.filter((bar) => bar.hit).length, total: bars.length };
}

function toBar(entry: PromptCacheHistoryEntry, cacheWindowMs: number): PromptCacheHistoryBar {
  const ratio = promptCacheHitRatio(entry) ?? 0;
  const isReturn =
    entry.kind === "turn" && entry.awayMs !== undefined && entry.awayMs > cacheWindowMs;
  return {
    at: entry.at,
    kind: entry.kind,
    ratio,
    hit: ratio >= HIT_RATIO,
    afterExpiry: entry.gapMs === null || entry.gapMs > cacheWindowMs,
    awayMs: isReturn ? (entry.awayMs ?? null) : null,
  };
}

function resolveLastReturn(bars: PromptCacheHistoryBar[]): PromptCacheLastReturn | null {
  const index = bars.findLastIndex((bar) => bar.awayMs !== null);
  const bar = bars[index];
  if (!bar || bar.awayMs === null) return null;
  let warmUps = 0;
  for (let before = index - 1; before >= 0 && bars[before]?.kind === "warm-up"; before -= 1) {
    warmUps += 1;
  }
  return { awayMs: bar.awayMs, warmUps, hit: bar.hit, ratio: bar.ratio };
}

function sumCachedShare(history: PromptCacheHistoryEntry[]): number {
  let read = 0;
  let total = 0;
  for (const entry of history) {
    read += entry.readTokens;
    total += entry.readTokens + entry.writeTokens + entry.uncachedTokens;
  }
  return total > 0 ? read / total : 0;
}

export function summarizePromptCacheHistory(
  history: PromptCacheHistoryEntry[] | undefined,
  cacheWindowMs: number,
): PromptCacheHistorySummary | null {
  if (!history || history.length === 0) {
    return null;
  }
  const bars = history.map((entry) => toBar(entry, cacheWindowMs));
  const misses = bars.filter((bar) => !bar.hit);
  return {
    bars,
    requests: countHits(bars),
    cachedShare: sumCachedShare(history),
    returns: countHits(bars.filter((bar) => bar.awayMs !== null)),
    warmUps: countHits(bars.filter((bar) => bar.kind === "warm-up")),
    missesAfterExpiry: misses.filter((bar) => bar.afterExpiry).length,
    missesWhileWarm: misses.filter((bar) => !bar.afterExpiry).length,
    lastReturn: resolveLastReturn(bars),
  };
}
