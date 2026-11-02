import { describe, expect, it } from "vitest";
import type {
  PromptCacheHistoryEntry,
  PromptCacheRequestKind,
} from "@getpaseo/protocol/agent-cache-warm";
import { summarizePromptCacheHistory } from "./prompt-cache-history";
import { buildInsightsColumns, summarizePromptCacheInsights } from "./prompt-cache-insights";

const MINUTE = 60_000;
const FIVE_MINUTES = 5 * MINUTE;

let clock = 0;

function entry(
  kind: PromptCacheRequestKind,
  readTokens: number,
  gapMinutes: number | null,
  extra: Partial<PromptCacheHistoryEntry> = {},
): PromptCacheHistoryEntry {
  clock += (gapMinutes ?? 0) * MINUTE + 1;
  return {
    at: new Date(clock).toISOString(),
    kind,
    readTokens,
    writeTokens: 1_000 - readTokens,
    uncachedTokens: 0,
    gapMs: gapMinutes === null ? null : gapMinutes * MINUTE,
    ...extra,
  };
}

describe("summarizePromptCacheHistory", () => {
  it("returns null before any request is recorded", () => {
    expect(summarizePromptCacheHistory(undefined)).toBeNull();
    expect(summarizePromptCacheHistory([])).toBeNull();
  });

  it("marks only misses a warm cache could have avoided", () => {
    const summary = summarizePromptCacheHistory([
      entry("turn", 0, null),
      entry("request", 900, 1),
      entry("turn", 0, 2, { afterCompaction: true }),
      entry("turn", 100, 30),
    ]);
    // The first request after a compaction is left out of the bars entirely.
    expect(summary?.bars.map((bar) => bar.avoidableMiss)).toEqual([false, false, true]);
    expect(summary?.bars[2]).toMatchObject({ hit: false, ratio: 0.1 });
    expect(summary?.cachedShare).toBeCloseTo(1_000 / 3_000);
  });
});

describe("summarizePromptCacheInsights", () => {
  it("splits misses into expired and dropped while warm, newest first", () => {
    const insights = summarizePromptCacheInsights({
      requests: [
        entry("turn", 0, null),
        entry("request", 900, 1),
        entry("warm-up", 1_000, 4.5),
        entry("request", 0, 7),
        entry("request", 0, 1),
        entry("turn", 0, 40),
      ],
      compactions: [],
      cacheWindowMs: FIVE_MINUTES,
    });
    // The agent's first request is shown but has no cache to hit, so it is not a request.
    expect(insights.requests).toBe(5);
    expect(insights.hits).toBe(2);
    expect(insights.warmUps).toBe(1);
    expect(insights.missesAfterExpiry).toBe(2);
    expect(insights.missesWhileWarm).toBe(1);
    expect(insights.misses.map((miss) => miss.gapMs)).toEqual([40 * MINUTE, MINUTE, 7 * MINUTE]);
  });

  it("fits a long session into the column budget and marks where it compacted", () => {
    const requests = Array.from({ length: 500 }, (_, index) =>
      entry("request", index === 250 ? 0 : 900, 1),
    );
    const compactionAt = requests[300]?.at ?? "";
    const columns = buildInsightsColumns(requests, [{ at: compactionAt, trigger: "manual" }], 100);
    expect(columns).toHaveLength(100);
    expect(columns.every((column) => column.requests === 5)).toBe(true);
    expect(columns.filter((column) => column.missed)).toHaveLength(1);
    expect(columns.findIndex((column) => column.compacted)).toBe(60);
  });
});
