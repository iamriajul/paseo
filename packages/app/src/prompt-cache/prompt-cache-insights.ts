import {
  isAvoidablePromptCacheMiss,
  isPromptCacheHit,
  isUncountedPromptCacheRequest,
  promptCacheInputTokens,
  type PromptCacheCompaction,
  type PromptCacheHistoryEntry,
  type PromptCacheTtl,
} from "@getpaseo/protocol/agent-cache-warm";
import {
  estimateRequestInputCostUsd,
  resolveClaudeTokenPrices,
} from "@getpaseo/protocol/claude-pricing";

/**
 * Columns the session chart draws at most. A long session has thousands of requests; past this
 * each column stands for a run of consecutive requests, so the whole range still fits. Zooming
 * into a column redraws its requests at up to this many columns again.
 */
export const INSIGHTS_MAX_COLUMNS = 120;

/** Estimated input cost of one request in USD, or null when its model has no known price. */
export type RequestPricer = (entry: PromptCacheHistoryEntry) => number | null;

export interface InsightsColumn {
  /** Time of the column's first request. */
  at: string;
  /** Time of the column's last request. */
  endAt: string;
  /** Index of the column's first request in the requests it was built from. */
  startIndex: number;
  /** Index after the column's last request. */
  endIndex: number;
  /** Requests this column stands for. */
  requests: number;
  /** Read tokens over input tokens across the column's requests. */
  ratio: number;
  /** At least one avoidable miss: the bar is drawn red even when the rest read the cache. */
  missed: boolean;
  /** Every request in the column was a hit, so the cache held the context it had before. */
  hit: boolean;
  /**
   * A compaction landed after the previous column's last request and by this column's last, so
   * the mark sits under the write that followed it. One that no request has followed yet marks
   * the last column.
   */
  compacted: boolean;
  /** Input of the column's last request: how large the context had grown. */
  contextTokens: number;
  /** Estimated input cost of the column's priced requests, and the warm-up part of it. */
  costUsd: number;
  warmUpCostUsd: number;
}

export interface InsightsMiss {
  at: string;
  /** A turn after time away, a request inside a turn, or a warm-up. */
  kind: PromptCacheHistoryEntry["kind"];
  writeTokens: number;
  /** The gap was longer than the cache window, so the cache had expired. */
  afterExpiry: boolean;
  gapMs: number | null;
}

/**
 * What warm-up bought. An idle stretch is a run of warm-ups between two requests of the agent's
 * own; it paid off when the request after it read the cache.
 */
export interface WarmUpPayback {
  /** Stretches the agent came back to with the cache still warm. */
  kept: number;
  /** What those returns would have cost to write again, less what they paid to read. */
  savedUsd: number;
  /** Stretches that ended in a miss, or ran out with no return yet. */
  lapsed: number;
  /** Warm-up spend on the lapsed stretches. */
  lapsedUsd: number;
  /** A stretch still running: the agent has not come back and the cache is still warm. */
  ongoing: boolean;
}

export interface InsightsCost {
  warmUpUsd: number;
  workUsd: number;
  /** Requests with no known price, left out of both sums. */
  unpriced: number;
  payback: WarmUpPayback;
}

export interface PromptCacheInsights {
  requests: number;
  hits: number;
  /** Read tokens over all input tokens: how much input was billed at the cache price. */
  cachedShare: number;
  readTokens: number;
  writeTokens: number;
  warmUps: number;
  missesAfterExpiry: number;
  missesWhileWarm: number;
  /** Newest first. */
  misses: InsightsMiss[];
  /** Newest first. */
  compactions: PromptCacheCompaction[];
  columns: InsightsColumn[];
  peakContextTokens: number;
  firstAt: string | null;
  lastAt: string | null;
  cost: InsightsCost;
}

/**
 * Prices each request by the model and TTL it recorded, else the agent's current ones. Entries
 * written before requests carried a model are priced as the agent's model.
 */
export function createRequestPricer(input: {
  fallbackModel: string | null | undefined;
  fallbackTtl: PromptCacheTtl;
}): RequestPricer {
  return (entry) => {
    const prices = resolveClaudeTokenPrices(entry.model ?? input.fallbackModel);
    if (!prices) return null;
    return estimateRequestInputCostUsd(entry, { prices, ttl: input.fallbackTtl });
  };
}

/** The write a hit avoided: its read billed as a write, less the read it paid. */
function avoidedRewriteUsd(entry: PromptCacheHistoryEntry, price: RequestPricer): number {
  const asRead = price(entry);
  const asWrite = price({
    ...entry,
    readTokens: 0,
    writeTokens: entry.writeTokens + entry.readTokens,
  });
  return asRead === null || asWrite === null ? 0 : Math.max(0, asWrite - asRead);
}

export function summarizeWarmUpPayback(input: {
  requests: readonly PromptCacheHistoryEntry[];
  price: RequestPricer;
  cacheWindowMs: number;
  nowMs: number;
}): WarmUpPayback {
  const { requests, price } = input;
  const payback: WarmUpPayback = {
    kept: 0,
    savedUsd: 0,
    lapsed: 0,
    lapsedUsd: 0,
    ongoing: false,
  };
  let stretchUsd: number | null = null;
  for (const entry of requests) {
    if (entry.kind === "warm-up") {
      stretchUsd = (stretchUsd ?? 0) + (price(entry) ?? 0);
      continue;
    }
    if (stretchUsd === null) continue;
    if (isPromptCacheHit(entry)) {
      payback.kept += 1;
      payback.savedUsd += avoidedRewriteUsd(entry, price);
    } else {
      payback.lapsed += 1;
      payback.lapsedUsd += stretchUsd;
    }
    stretchUsd = null;
  }
  if (stretchUsd !== null) {
    const lastAt = Date.parse(requests.at(-1)?.at ?? "");
    if (input.nowMs - lastAt < input.cacheWindowMs) {
      payback.ongoing = true;
    } else {
      payback.lapsed += 1;
      payback.lapsedUsd += stretchUsd;
    }
  }
  return payback;
}

function summarizeCost(input: {
  requests: readonly PromptCacheHistoryEntry[];
  price: RequestPricer;
  cacheWindowMs: number;
  nowMs: number;
}): InsightsCost {
  let warmUpUsd = 0;
  let workUsd = 0;
  let unpriced = 0;
  for (const entry of input.requests) {
    const usd = input.price(entry);
    if (usd === null) {
      unpriced += 1;
    } else if (entry.kind === "warm-up") {
      warmUpUsd += usd;
    } else {
      workUsd += usd;
    }
  }
  return { warmUpUsd, workUsd, unpriced, payback: summarizeWarmUpPayback(input) };
}

const NO_PRICE: RequestPricer = () => null;

function toColumn(
  entries: PromptCacheHistoryEntry[],
  bounds: { previousAt: string | null; isLast: boolean; startIndex: number },
  compactions: readonly PromptCacheCompaction[],
  price: RequestPricer,
): InsightsColumn {
  let read = 0;
  let total = 0;
  let costUsd = 0;
  let warmUpCostUsd = 0;
  for (const entry of entries) {
    read += entry.readTokens;
    total += promptCacheInputTokens(entry);
    const usd = price(entry) ?? 0;
    costUsd += usd;
    if (entry.kind === "warm-up") warmUpCostUsd += usd;
  }
  const first = entries[0] as PromptCacheHistoryEntry;
  const last = entries.at(-1) as PromptCacheHistoryEntry;
  return {
    at: first.at,
    endAt: last.at,
    startIndex: bounds.startIndex,
    endIndex: bounds.startIndex + entries.length,
    requests: entries.length,
    ratio: total > 0 ? read / total : 0,
    missed: entries.some(isAvoidablePromptCacheMiss),
    hit: entries.every(isPromptCacheHit),
    compacted: compactions.some(
      (compaction) =>
        (bounds.previousAt === null || compaction.at > bounds.previousAt) &&
        (bounds.isLast || compaction.at <= last.at),
    ),
    contextTokens: promptCacheInputTokens(last),
    costUsd,
    warmUpCostUsd,
  };
}

export function buildInsightsColumns(
  requests: readonly PromptCacheHistoryEntry[],
  compactions: readonly PromptCacheCompaction[],
  maxColumns = INSIGHTS_MAX_COLUMNS,
  price: RequestPricer = NO_PRICE,
): InsightsColumn[] {
  const perColumn = Math.max(1, Math.ceil(requests.length / maxColumns));
  const groups: PromptCacheHistoryEntry[][] = [];
  for (let index = 0; index < requests.length; index += perColumn) {
    groups.push(requests.slice(index, index + perColumn));
  }
  return groups.map((group, index) =>
    toColumn(
      group,
      {
        previousAt: groups[index - 1]?.at(-1)?.at ?? null,
        isLast: index === groups.length - 1,
        startIndex: index * perColumn,
      },
      compactions,
      price,
    ),
  );
}

/** The requests every count and chart uses: the first request after a compaction is left out. */
export function selectShownRequests(
  requests: readonly PromptCacheHistoryEntry[],
): PromptCacheHistoryEntry[] {
  return requests.filter((entry) => !isUncountedPromptCacheRequest(entry));
}

export function summarizePromptCacheInsights(input: {
  requests: readonly PromptCacheHistoryEntry[];
  compactions: readonly PromptCacheCompaction[];
  cacheWindowMs: number;
  price?: RequestPricer;
  nowMs?: number;
}): PromptCacheInsights {
  const { compactions, cacheWindowMs } = input;
  const price = input.price ?? NO_PRICE;
  const shown = selectShownRequests(input.requests);
  // The agent's first request is shown, as a neutral first write, but it had no cache to hit.
  const counted = shown.filter((entry) => entry.gapMs !== null);
  let readTokens = 0;
  let writeTokens = 0;
  let inputTokens = 0;
  let hits = 0;
  let warmUps = 0;
  let peakContextTokens = 0;
  const misses: InsightsMiss[] = [];
  for (const entry of shown) {
    readTokens += entry.readTokens;
    writeTokens += entry.writeTokens;
    inputTokens += promptCacheInputTokens(entry);
    peakContextTokens = Math.max(peakContextTokens, promptCacheInputTokens(entry));
    if (entry.kind === "warm-up") warmUps += 1;
  }
  for (const entry of counted) {
    if (isPromptCacheHit(entry)) hits += 1;
    if (isAvoidablePromptCacheMiss(entry)) {
      misses.push({
        at: entry.at,
        kind: entry.kind,
        writeTokens: entry.writeTokens,
        afterExpiry: entry.gapMs !== null && entry.gapMs > cacheWindowMs,
        gapMs: entry.gapMs,
      });
    }
  }
  const missesAfterExpiry = misses.filter((miss) => miss.afterExpiry).length;
  return {
    requests: counted.length,
    hits,
    cachedShare: inputTokens > 0 ? readTokens / inputTokens : 0,
    readTokens,
    writeTokens,
    warmUps,
    missesAfterExpiry,
    missesWhileWarm: misses.length - missesAfterExpiry,
    misses: misses.toReversed(),
    compactions: compactions.toReversed(),
    columns: buildInsightsColumns(shown, compactions, INSIGHTS_MAX_COLUMNS, price),
    peakContextTokens,
    firstAt: shown[0]?.at ?? null,
    lastAt: shown.at(-1)?.at ?? null,
    // Cost counts every request, the one after a compaction too: it was billed like any other.
    cost: summarizeCost({
      requests: input.requests,
      price,
      cacheWindowMs,
      nowMs: input.nowMs ?? Date.now(),
    }),
  };
}
