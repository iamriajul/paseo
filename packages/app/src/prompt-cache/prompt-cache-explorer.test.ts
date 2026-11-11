import { describe, expect, it } from "vitest";
import type { PromptCacheHistoryEntry } from "@getpaseo/protocol/agent-cache-warm";
import {
  describeReportedCost,
  describeRequest,
  indexSwitchMisses,
  matchesRequestFilter,
  sliceInsightsRange,
} from "./prompt-cache-explorer";
import { createRequestPricer } from "./prompt-cache-insights";

const MINUTE = 60_000;
const FIVE_MINUTES = 5 * MINUTE;

function at(minute: number): string {
  return new Date(Date.UTC(2026, 10, 3, 9, minute)).toISOString();
}

function request(
  minute: number,
  overrides: Partial<PromptCacheHistoryEntry> = {},
): PromptCacheHistoryEntry {
  return {
    at: at(minute),
    kind: "request",
    readTokens: 450_000,
    writeTokens: 1_000,
    uncachedTokens: 0,
    gapMs: MINUTE,
    previousInputTokens: 450_000,
    model: "claude-opus-5-5",
    ...overrides,
  };
}

describe("sliceInsightsRange", () => {
  const shown = [request(0), request(1), request(2), request(3)];
  const compactions = [
    { at: at(0) + "x", trigger: "manual" as const },
    { at: at(2) + "x", trigger: "auto" as const },
  ];

  it("keeps a compaction in the range whose write followed it", () => {
    const zoomed = sliceInsightsRange({ shown, compactions, range: { start: 1, end: 3 } });
    expect(zoomed.requests.map((entry) => entry.at)).toEqual([at(1), at(2)]);
    expect(zoomed.compactions.map((compaction) => compaction.trigger)).toEqual(["manual"]);
  });

  it("keeps a trailing compaction no request has followed in the last range", () => {
    const tail = sliceInsightsRange({ shown, compactions, range: { start: 3, end: 4 } });
    expect(tail.compactions.map((compaction) => compaction.trigger)).toEqual(["auto"]);
  });
});

describe("matchesRequestFilter", () => {
  it("finds misses, warm-ups and turns", () => {
    const miss = request(10, {
      kind: "turn",
      readTokens: 0,
      writeTokens: 451_000,
      gapMs: 30 * MINUTE,
    });
    const warmUp = request(11, { kind: "warm-up" });
    expect(matchesRequestFilter(miss, "misses")).toBe(true);
    expect(matchesRequestFilter(warmUp, "misses")).toBe(false);
    expect(matchesRequestFilter(warmUp, "warm-ups")).toBe(true);
    expect(matchesRequestFilter(miss, "turns")).toBe(true);
  });
});

describe("describeRequest", () => {
  const price = createRequestPricer({ fallbackModel: null, fallbackTtl: "5m" });

  it("describes a missed return, its time away and what writing the context cost", () => {
    const row = describeRequest({
      entry: request(40, {
        kind: "turn",
        readTokens: 0,
        writeTokens: 451_000,
        gapMs: 4 * MINUTE,
        awayMs: 35 * MINUTE,
      }),
      price,
      cacheWindowMs: FIVE_MINUTES,
    });
    expect(row).toMatchObject({ kind: "Turn", tone: "miss" });
    // The gap to the warm-up before it was 4 minutes, but the cache missed: dropped while warm.
    expect(row.outcome).toBe("miss · dropped while warm");
    expect(row.detail).toBe("451k context · read 0 · wrote 451k · after 35m · ≈ $2.25 · opus-5-5");
  });

  it("charges a miss inside the cache window to the account switch that caused it", () => {
    const entry = request(40, { readTokens: 0, writeTokens: 120_000, gapMs: 2 * MINUTE });
    const switches = indexSwitchMisses([
      { at: at(39), account: "u***a@example.com" },
      {
        at: at(40),
        account: "u***b@example.com",
        from: "u***a@example.com",
        reason: "quota",
        statusCode: 429,
        missAt: entry.at,
      },
    ]);
    const row = describeRequest({
      entry,
      price,
      cacheWindowMs: FIVE_MINUTES,
      switchedAccount: switches.get(entry.at),
    });
    expect(row).toMatchObject({ outcome: "miss · account switched", tone: "miss" });
    expect(row.detail).toMatch(
      /^switched u\*\*\*a@example\.com → u\*\*\*b@example\.com \(quota, 429\) · 120k context/,
    );
  });

  it("keeps an expired cache as the cause even when the account also switched", () => {
    const entry = request(40, { readTokens: 0, writeTokens: 120_000, gapMs: 20 * MINUTE });
    const row = describeRequest({
      entry,
      price,
      cacheWindowMs: FIVE_MINUTES,
      switchedAccount: { at: entry.at, account: "B", from: "A", missAt: entry.at },
    });
    expect(row.outcome).toBe("miss · expired");
    expect(row.detail).not.toContain("switched");
  });

  it("says why the warm-up let an expired cache go, first on the row", () => {
    const entry = request(40, { readTokens: 0, writeTokens: 120_000, gapMs: 20 * MINUTE });
    const row = describeRequest({
      entry,
      price,
      cacheWindowMs: FIVE_MINUTES,
      warmUpStop: { at: at(24), reason: "moved", account: "n***u" },
    });
    expect(row.outcome).toBe("miss · expired");
    expect(row.detail).toMatch(
      /^Warm-up skipped: the gateway had already moved this session to n\*\*\*u, cache left to expire · 120k context/,
    );
  });

  it("marks a hit and prices it as a read", () => {
    const row = describeRequest({ entry: request(5), price, cacheWindowMs: FIVE_MINUTES });
    expect(row).toMatchObject({ kind: "Tool step", outcome: "hit", tone: "hit" });
    expect(row.detail).toContain("≈ $0.10");
  });
});

describe("describeReportedCost", () => {
  it("puts Claude Code's figure and the warm-ups side by side", () => {
    expect(describeReportedCost({ claudeCodeUsd: 43.77, warmUpUsd: 1.3 })).toMatch(
      /^Session cost: Claude Code reported \$43\.77 \+ warm-ups ≈ \$1\.30 · \$45\.07 in all\./,
    );
    expect(describeReportedCost({ claudeCodeUsd: null, warmUpUsd: null })).toBeNull();
  });

  it("says Claude Code leaves out fork warm-ups only when there are some", () => {
    expect(describeReportedCost({ claudeCodeUsd: 43.77, warmUpUsd: 1.3 })).toContain(
      "but not fork warm-ups",
    );
    expect(describeReportedCost({ claudeCodeUsd: 43.77, warmUpUsd: null })).not.toContain(
      "warm-ups",
    );
  });
});
