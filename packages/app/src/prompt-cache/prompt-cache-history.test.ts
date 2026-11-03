import { describe, expect, it } from "vitest";
import type {
  PromptCacheHistoryEntry,
  PromptCacheRequestKind,
} from "@getpaseo/protocol/agent-cache-warm";
import { summarizePromptCacheHistory } from "./prompt-cache-history";
import {
  buildInsightsColumns,
  createRequestPricer,
  summarizePromptCacheInsights,
  summarizeWarmUpPayback,
} from "./prompt-cache-insights";

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

describe("prompt cache cost insights", () => {
  // 1M-token context on Opus 5.5: a read costs $0.20, a 5m write $5.
  function opus(
    kind: PromptCacheRequestKind,
    readTokens: number,
    writeTokens: number,
    gapMinutes: number | null,
  ): PromptCacheHistoryEntry {
    return {
      ...entry(kind, 0, gapMinutes),
      readTokens,
      writeTokens,
      model: "claude-opus-5-5",
      ...(gapMinutes === null ? {} : { previousInputTokens: 1_000_000 }),
    };
  }
  const price = createRequestPricer({ fallbackModel: null, fallbackTtl: "5m" });

  it("splits warm-up spend from work and counts what a kept cache saved", () => {
    const requests = [
      opus("turn", 0, 1_000_000, null),
      opus("warm-up", 1_000_000, 0, 4),
      opus("warm-up", 1_000_000, 0, 4),
      opus("turn", 1_000_000, 0, 3),
    ];
    const insights = summarizePromptCacheInsights({
      requests,
      compactions: [],
      cacheWindowMs: FIVE_MINUTES,
      price,
      nowMs: Date.parse(requests.at(-1)?.at ?? ""),
    });
    expect(insights.cost.warmUpUsd).toBeCloseTo(0.4, 6);
    expect(insights.cost.workUsd).toBeCloseTo(5 + 0.2, 6);
    // The return read 1M instead of writing it: $5 avoided, less the $0.20 read.
    expect(insights.cost.payback).toMatchObject({ kept: 1, lapsed: 0, ongoing: false });
    expect(insights.cost.payback.savedUsd).toBeCloseTo(4.8, 6);
  });

  it("counts warm-ups that ended in a miss, or ran out with no return, as lapsed", () => {
    const missed = [
      opus("turn", 0, 1_000_000, null),
      opus("warm-up", 1_000_000, 0, 4),
      opus("turn", 0, 1_000_000, 60),
      opus("warm-up", 1_000_000, 0, 4),
    ];
    const lastAt = Date.parse(missed.at(-1)?.at ?? "");
    const ranOut = summarizeWarmUpPayback({
      requests: missed,
      price,
      cacheWindowMs: FIVE_MINUTES,
      nowMs: lastAt + 10 * MINUTE,
    });
    expect(ranOut).toMatchObject({ kept: 0, lapsed: 2, ongoing: false });
    expect(ranOut.lapsedUsd).toBeCloseTo(0.4, 6);

    const stillWarm = summarizeWarmUpPayback({
      requests: missed,
      price,
      cacheWindowMs: FIVE_MINUTES,
      nowMs: lastAt + MINUTE,
    });
    expect(stillWarm).toMatchObject({ lapsed: 1, ongoing: true });
  });

  it("prices each request on its own model and leaves unknown models out", () => {
    const requests = [
      opus("turn", 0, 1_000_000, null),
      { ...opus("turn", 0, 1_000_000, 1), model: "claude-haiku-5-5" },
      { ...opus("turn", 0, 1_000_000, 1), model: "gpt-5" },
    ];
    const insights = summarizePromptCacheInsights({
      requests,
      compactions: [],
      cacheWindowMs: FIVE_MINUTES,
      price,
    });
    // Opus writes 1M for $5; Haiku past 100k is $0.50 input, $0.625 for a 5m write.
    expect(insights.cost.workUsd).toBeCloseTo(5.625, 6);
    expect(insights.cost.unpriced).toBe(1);
  });

  it("gives each column the range of requests it stands for, so it can be zoomed into", () => {
    const requests = Array.from({ length: 10 }, () => entry("request", 900, 1));
    const columns = buildInsightsColumns(requests, [], 4);
    expect(columns.map(({ startIndex, endIndex }) => [startIndex, endIndex])).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
      [9, 10],
    ]);
  });
});
