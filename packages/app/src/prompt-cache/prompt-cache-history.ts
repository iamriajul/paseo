import {
  isAvoidablePromptCacheMiss,
  isPromptCacheHit,
  isUncountedPromptCacheRequest,
  promptCacheHitRatio,
  type PromptCacheHistoryEntry,
  type PromptCacheRequestKind,
} from "@getpaseo/protocol/agent-cache-warm";

export interface PromptCacheHistoryBar {
  at: string;
  kind: PromptCacheRequestKind;
  /** Cached share of the request's input, 0 when it recorded no input. */
  ratio: number;
  hit: boolean;
  /** A miss a warm cache would have avoided; the first request and a post-compaction write are not. */
  avoidableMiss: boolean;
}

/** The recent window the pill draws; the insights dialog covers the whole session. */
export interface PromptCacheHistorySummary {
  bars: PromptCacheHistoryBar[];
  /** Read tokens over all input tokens in the window. */
  cachedShare: number;
}

function toBar(entry: PromptCacheHistoryEntry): PromptCacheHistoryBar {
  return {
    at: entry.at,
    kind: entry.kind,
    ratio: promptCacheHitRatio(entry) ?? 0,
    hit: isPromptCacheHit(entry),
    avoidableMiss: isAvoidablePromptCacheMiss(entry),
  };
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
): PromptCacheHistorySummary | null {
  // The first request after a compaction is left out of the bars too.
  const shown = (history ?? []).filter((entry) => !isUncountedPromptCacheRequest(entry));
  if (shown.length === 0) {
    return null;
  }
  return { bars: shown.map(toBar), cachedShare: sumCachedShare(shown) };
}
