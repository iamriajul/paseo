import {
  isAvoidablePromptCacheMiss,
  isPromptCacheHit,
  promptCacheInputTokens,
  type PromptCacheCompaction,
  type PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";

/**
 * Columns the session chart draws at most. A long session has thousands of requests; past this
 * each column stands for a run of consecutive requests, so the whole session still fits.
 */
export const INSIGHTS_MAX_COLUMNS = 120;

export interface InsightsColumn {
  /** Time of the column's first request. */
  at: string;
  /** Requests this column stands for. */
  requests: number;
  /** Read tokens over input tokens across the column's requests. */
  ratio: number;
  /** At least one avoidable miss: the bar is drawn red even when the rest read the cache. */
  missed: boolean;
  /**
   * A compaction landed after the previous column's last request and by this column's last, so
   * the mark sits under the write that followed it. One that no request has followed yet marks
   * the last column.
   */
  compacted: boolean;
  /** Input of the column's last request: how large the context had grown. */
  contextTokens: number;
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
}

function toColumn(
  entries: PromptCacheHistoryEntry[],
  bounds: { previousAt: string | null; isLast: boolean },
  compactions: readonly PromptCacheCompaction[],
): InsightsColumn {
  let read = 0;
  let total = 0;
  for (const entry of entries) {
    read += entry.readTokens;
    total += promptCacheInputTokens(entry);
  }
  const first = entries[0] as PromptCacheHistoryEntry;
  const last = entries.at(-1) as PromptCacheHistoryEntry;
  return {
    at: first.at,
    requests: entries.length,
    ratio: total > 0 ? read / total : 0,
    missed: entries.some(isAvoidablePromptCacheMiss),
    compacted: compactions.some(
      (compaction) =>
        (bounds.previousAt === null || compaction.at > bounds.previousAt) &&
        (bounds.isLast || compaction.at <= last.at),
    ),
    contextTokens: promptCacheInputTokens(last),
  };
}

export function buildInsightsColumns(
  requests: readonly PromptCacheHistoryEntry[],
  compactions: readonly PromptCacheCompaction[],
  maxColumns = INSIGHTS_MAX_COLUMNS,
): InsightsColumn[] {
  const perColumn = Math.max(1, Math.ceil(requests.length / maxColumns));
  const groups: PromptCacheHistoryEntry[][] = [];
  for (let index = 0; index < requests.length; index += perColumn) {
    groups.push(requests.slice(index, index + perColumn));
  }
  return groups.map((group, index) =>
    toColumn(
      group,
      { previousAt: groups[index - 1]?.at(-1)?.at ?? null, isLast: index === groups.length - 1 },
      compactions,
    ),
  );
}

export function summarizePromptCacheInsights(input: {
  requests: readonly PromptCacheHistoryEntry[];
  compactions: readonly PromptCacheCompaction[];
  cacheWindowMs: number;
}): PromptCacheInsights {
  const { requests, compactions, cacheWindowMs } = input;
  let readTokens = 0;
  let writeTokens = 0;
  let inputTokens = 0;
  let hits = 0;
  let warmUps = 0;
  let peakContextTokens = 0;
  const misses: InsightsMiss[] = [];
  for (const entry of requests) {
    readTokens += entry.readTokens;
    writeTokens += entry.writeTokens;
    inputTokens += promptCacheInputTokens(entry);
    peakContextTokens = Math.max(peakContextTokens, promptCacheInputTokens(entry));
    if (isPromptCacheHit(entry)) hits += 1;
    if (entry.kind === "warm-up") warmUps += 1;
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
    requests: requests.length,
    hits,
    cachedShare: inputTokens > 0 ? readTokens / inputTokens : 0,
    readTokens,
    writeTokens,
    warmUps,
    missesAfterExpiry,
    missesWhileWarm: misses.length - missesAfterExpiry,
    misses: misses.toReversed(),
    compactions: compactions.toReversed(),
    columns: buildInsightsColumns(requests, compactions),
    peakContextTokens,
    firstAt: requests[0]?.at ?? null,
    lastAt: requests.at(-1)?.at ?? null,
  };
}
