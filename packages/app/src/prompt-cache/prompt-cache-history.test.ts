import { describe, expect, it } from "vitest";
import type {
  PromptCacheHistoryEntry,
  PromptCacheRequestKind,
} from "@getpaseo/protocol/agent-cache-warm";
import { summarizePromptCacheHistory } from "./prompt-cache-history";

const MINUTE = 60_000;
const FIVE_MINUTES = 5 * MINUTE;

let clock = 0;

function entry(
  kind: PromptCacheRequestKind,
  readTokens: number,
  gapMinutes: number | null,
  awayMinutes?: number,
): PromptCacheHistoryEntry {
  clock += (gapMinutes ?? 0) * MINUTE + 1;
  return {
    at: new Date(clock).toISOString(),
    kind,
    readTokens,
    writeTokens: 1_000 - readTokens,
    uncachedTokens: 0,
    gapMs: gapMinutes === null ? null : gapMinutes * MINUTE,
    ...(awayMinutes === undefined ? {} : { awayMs: awayMinutes * MINUTE }),
  };
}

describe("summarizePromptCacheHistory", () => {
  it("returns null before any request is recorded", () => {
    expect(summarizePromptCacheHistory(undefined, FIVE_MINUTES)).toBeNull();
    expect(summarizePromptCacheHistory([], FIVE_MINUTES)).toBeNull();
  });

  it("separates returns kept warm by warm-ups from misses after the cache expired", () => {
    const summary = summarizePromptCacheHistory(
      [
        entry("turn", 0, null),
        entry("request", 900, 1),
        entry("warm-up", 1_000, 4.5),
        entry("warm-up", 1_000, 4.5),
        entry("turn", 990, 2, 11),
        entry("request", 0, 7),
        entry("request", 0, 1),
        entry("turn", 0, 40, 40),
      ],
      FIVE_MINUTES,
    );
    expect(summary?.requests).toEqual({ hit: 4, total: 8 });
    expect(summary?.warmUps).toEqual({ hit: 2, total: 2 });
    expect(summary?.returns).toEqual({ hit: 1, total: 2 });
    expect(summary?.missesAfterExpiry).toBe(3);
    expect(summary?.missesWhileWarm).toBe(1);
    expect(summary?.cachedShare).toBeCloseTo(3_890 / 8_000);
    expect(summary?.lastReturn).toEqual({ awayMs: 40 * MINUTE, warmUps: 0, hit: false, ratio: 0 });
  });

  it("counts the warm-ups that bridged the latest return", () => {
    const summary = summarizePromptCacheHistory(
      [
        entry("turn", 990, 1, 1),
        entry("warm-up", 1_000, 4.5),
        entry("warm-up", 1_000, 4.5),
        entry("warm-up", 1_000, 4.5),
        entry("turn", 980, 3, 16.5),
      ],
      FIVE_MINUTES,
    );
    expect(summary?.lastReturn).toEqual({
      awayMs: 16.5 * MINUTE,
      warmUps: 3,
      hit: true,
      ratio: 0.98,
    });
  });

  it("calls a request that only read a small shared prefix a miss", () => {
    const summary = summarizePromptCacheHistory([entry("turn", 100, 30, 30)], FIVE_MINUTES);
    expect(summary?.bars[0]).toMatchObject({ hit: false, ratio: 0.1, afterExpiry: true });
  });

  it("judges time away against a 1 hour window", () => {
    const summary = summarizePromptCacheHistory([entry("turn", 990, 20, 20)], 60 * MINUTE);
    expect(summary?.returns.total).toBe(0);
    expect(summary?.bars[0]?.afterExpiry).toBe(false);
  });
});
