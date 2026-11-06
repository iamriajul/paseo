import {
  FIVE_MINUTE_CACHE_WARM_INTERVAL_MS,
  FIVE_MINUTE_CACHE_WARM_MAX_PINGS,
  FIVE_MINUTE_CACHE_WINDOW_MS,
  ONE_HOUR_CACHE_WARM_INTERVAL_MS,
  ONE_HOUR_CACHE_WARM_MAX_PINGS,
  ONE_HOUR_CACHE_WINDOW_MS,
  promptCacheInputTokens,
  sumPromptCacheTotals,
  type PromptCacheHistoryEntry,
  type PromptCacheTtl,
} from "@getpaseo/protocol/agent-cache-warm";
import type { RequestPricer } from "./prompt-cache-insights";

/** One stretch of the session: turns running, or nobody working (warm-ups count as idle). */
export interface ActivitySegment {
  kind: "active" | "idle";
  startMs: number;
  endMs: number;
}

/** The time between the agent's last request and the next turn, and what the cache held then. */
export interface IdleGap {
  ms: number;
  contextTokens: number;
  model: string | undefined;
}

export type GapBucketKey = "under5m" | "under1h" | "over1h";

export interface GapBucket {
  key: GapBucketKey;
  count: number;
  totalMs: number;
}

export interface SessionActivity {
  startMs: number;
  endMs: number;
  activeMs: number;
  idleMs: number;
  segments: ActivitySegment[];
  /** Finished gaps only: each ended with a turn. The idle stretch running now is not one yet. */
  gaps: IdleGap[];
  buckets: GapBucket[];
  /** The idle stretch running now, from the last request to now; 0 while a turn runs. */
  ongoingIdleMs: number;
  /**
   * The journal starts after the session did: it was seeded from the snapshot's latest requests
   * when the journal arrived, so earlier requests are missing and the figures cover less.
   */
  partial: boolean;
}

const GAP_BUCKET_BOUNDS: ReadonlyArray<readonly [GapBucketKey, number]> = [
  ["under5m", FIVE_MINUTE_CACHE_WINDOW_MS],
  ["under1h", ONE_HOUR_CACHE_WINDOW_MS],
  ["over1h", Number.POSITIVE_INFINITY],
];

function bucketOf(ms: number): GapBucketKey {
  for (const [key, bound] of GAP_BUCKET_BOUNDS) {
    if (ms <= bound) return key;
  }
  return "over1h";
}

/**
 * Splits the session into turns and the idle gaps between them, from its requests. A turn runs
 * from its first request to its last; a warm-up is nobody's work, so it sits inside a gap.
 */
export function summarizeSessionActivity(input: {
  requests: readonly PromptCacheHistoryEntry[];
  /** The session's own request total from the snapshot; more than the journal holds means partial. */
  sessionRequests: number | undefined;
  /** The agent is running a turn now. */
  busy: boolean;
  nowMs: number;
}): SessionActivity | null {
  const own = input.requests.filter((entry) => entry.kind !== "warm-up");
  if (own.length === 0) return null;
  const segments: ActivitySegment[] = [];
  const gaps: IdleGap[] = [];
  let turnStart = Date.parse(own[0]!.at);
  let previous = own[0]!;
  for (const entry of own.slice(1)) {
    const atMs = Date.parse(entry.at);
    if (entry.kind === "turn") {
      const previousMs = Date.parse(previous.at);
      segments.push({ kind: "active", startMs: turnStart, endMs: previousMs });
      segments.push({ kind: "idle", startMs: previousMs, endMs: atMs });
      gaps.push({
        ms: atMs - previousMs,
        contextTokens: entry.previousInputTokens ?? promptCacheInputTokens(previous),
        model: entry.model ?? previous.model,
      });
      turnStart = atMs;
    }
    previous = entry;
  }
  const lastMs = Date.parse(previous.at);
  const endMs = Math.max(lastMs, input.nowMs);
  if (input.busy) {
    segments.push({ kind: "active", startMs: turnStart, endMs });
  } else {
    segments.push({ kind: "active", startMs: turnStart, endMs: lastMs });
    if (endMs > lastMs) segments.push({ kind: "idle", startMs: lastMs, endMs });
  }
  const buckets: GapBucket[] = GAP_BUCKET_BOUNDS.map(([key]) => ({ key, count: 0, totalMs: 0 }));
  for (const gap of gaps) {
    const bucket = buckets.find((candidate) => candidate.key === bucketOf(gap.ms))!;
    bucket.count += 1;
    bucket.totalMs += gap.ms;
  }
  let activeMs = 0;
  let idleMs = 0;
  for (const segment of segments) {
    if (segment.kind === "active") activeMs += segment.endMs - segment.startMs;
    else idleMs += segment.endMs - segment.startMs;
  }
  const recorded = sumPromptCacheTotals(input.requests).requests;
  return {
    startMs: Date.parse(own[0]!.at),
    endMs,
    activeMs,
    idleMs,
    segments,
    gaps,
    buckets,
    ongoingIdleMs: input.busy ? 0 : endMs - lastMs,
    partial: input.sessionRequests !== undefined && input.sessionRequests > recorded,
  };
}

export type CacheStrategyKey = "5m" | "5m-warm" | "1h" | "1h-warm";

export interface CacheStrategyCost {
  key: CacheStrategyKey;
  /** What coming back after each gap costs: reads while covered, warm-ups, rewrites after. */
  returnsUsd: number;
  /** The session's new context written at this window's write price. */
  writesUsd: number;
  totalUsd: number;
  /** Gaps this strategy came back to with a warm cache. */
  covered: number;
}

interface StrategyShape {
  key: CacheStrategyKey;
  ttl: PromptCacheTtl;
  windowMs: number;
  intervalMs: number;
  maxPings: number;
}

const STRATEGIES: readonly StrategyShape[] = [
  { key: "5m", ttl: "5m", windowMs: FIVE_MINUTE_CACHE_WINDOW_MS, intervalMs: 1, maxPings: 0 },
  {
    key: "5m-warm",
    ttl: "5m",
    windowMs: FIVE_MINUTE_CACHE_WINDOW_MS,
    intervalMs: FIVE_MINUTE_CACHE_WARM_INTERVAL_MS,
    maxPings: FIVE_MINUTE_CACHE_WARM_MAX_PINGS,
  },
  { key: "1h", ttl: "1h", windowMs: ONE_HOUR_CACHE_WINDOW_MS, intervalMs: 1, maxPings: 0 },
  {
    key: "1h-warm",
    ttl: "1h",
    windowMs: ONE_HOUR_CACHE_WINDOW_MS,
    intervalMs: ONE_HOUR_CACHE_WARM_INTERVAL_MS,
    maxPings: ONE_HOUR_CACHE_WARM_MAX_PINGS,
  },
];

function priceTokens(
  price: RequestPricer,
  tokens: { read: number; write: number; ttl: PromptCacheTtl; model: string | undefined },
): number {
  return (
    price({
      at: "",
      kind: "turn",
      readTokens: tokens.read,
      writeTokens: tokens.write,
      uncachedTokens: 0,
      gapMs: null,
      writeTtl: tokens.ttl,
      ...(tokens.model ? { model: tokens.model } : {}),
    }) ?? 0
  );
}

/** New context the session wrote, outside rewrites of what an earlier request had cached. */
function newContextWrites(requests: readonly PromptCacheHistoryEntry[]) {
  const writes: { tokens: number; model: string | undefined }[] = [];
  for (const entry of requests) {
    if (entry.kind === "warm-up") continue;
    const grown =
      entry.kind === "turn" && entry.previousInputTokens !== undefined
        ? Math.max(0, promptCacheInputTokens(entry) - entry.previousInputTokens)
        : entry.writeTokens;
    writes.push({
      tokens: Math.min(grown, entry.writeTokens + entry.uncachedTokens),
      model: entry.model,
    });
  }
  return writes;
}

/**
 * What this session's gaps would have cost under each window, with and without warm-up. Coming
 * back reads the context when the cache is still warm and writes it all again when not; warm-up
 * reads it once per interval up to its cap. Reads inside a turn cost the same under every
 * window, so they are left out; the session's new writes are priced at each window's rate.
 */
export function compareCacheStrategies(input: {
  requests: readonly PromptCacheHistoryEntry[];
  gaps: readonly IdleGap[];
  price: RequestPricer;
}): CacheStrategyCost[] {
  const writes = newContextWrites(input.requests);
  return STRATEGIES.map((strategy) => {
    let returnsUsd = 0;
    let covered = 0;
    for (const gap of input.gaps) {
      const read = priceTokens(input.price, {
        read: gap.contextTokens,
        write: 0,
        ttl: strategy.ttl,
        model: gap.model,
      });
      const rewrite = priceTokens(input.price, {
        read: 0,
        write: gap.contextTokens,
        ttl: strategy.ttl,
        model: gap.model,
      });
      const pingsNeeded =
        gap.ms <= strategy.windowMs
          ? 0
          : Math.ceil((gap.ms - strategy.windowMs) / strategy.intervalMs);
      if (pingsNeeded <= strategy.maxPings) {
        returnsUsd += (pingsNeeded + 1) * read;
        covered += 1;
      } else {
        returnsUsd += strategy.maxPings * read + rewrite;
      }
    }
    const writesUsd = writes.reduce(
      (sum, write) =>
        sum +
        priceTokens(input.price, {
          read: 0,
          write: write.tokens,
          ttl: strategy.ttl,
          model: write.model,
        }),
      0,
    );
    return { key: strategy.key, returnsUsd, writesUsd, totalUsd: returnsUsd + writesUsd, covered };
  });
}
