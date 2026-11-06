import { describe, expect, it } from "vitest";
import type { PromptCacheHistoryEntry } from "@getpaseo/protocol/agent-cache-warm";
import { createRequestPricer } from "./prompt-cache-insights";
import { compareCacheStrategies, summarizeSessionActivity } from "./session-activity";

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-06T09:00:00.000Z");

function entry(
  atMin: number,
  kind: PromptCacheHistoryEntry["kind"],
  extra: Partial<PromptCacheHistoryEntry> = {},
): PromptCacheHistoryEntry {
  return {
    at: new Date(T0 + atMin * MINUTE).toISOString(),
    kind,
    readTokens: 100_000,
    writeTokens: 0,
    uncachedTokens: 0,
    gapMs: atMin === 0 ? null : MINUTE,
    model: "claude-opus-5-5",
    previousInputTokens: atMin === 0 ? undefined : 100_000,
    ...extra,
  };
}

// Turns at 0–2, 5–6 (3 min gap), 30 (24 min gap, warm-ups inside) and 120 (90 min gap).
const SESSION = [
  entry(0, "turn", { readTokens: 0, writeTokens: 100_000 }),
  entry(1, "request"),
  entry(2, "request"),
  entry(5, "turn"),
  entry(6, "request"),
  entry(10, "warm-up"),
  entry(14, "warm-up"),
  entry(30, "turn"),
  entry(120, "turn"),
];

describe("summarizeSessionActivity", () => {
  it("splits turns from idle gaps, counting warm-ups as idle, and buckets the gaps by window", () => {
    const activity = summarizeSessionActivity({
      requests: SESSION,
      sessionRequests: 8,
      busy: false,
      nowMs: T0 + 130 * MINUTE,
    })!;
    expect(activity.gaps.map((gap) => gap.ms / MINUTE)).toEqual([3, 24, 90]);
    expect(activity.buckets).toEqual([
      { key: "under5m", count: 1, totalMs: 3 * MINUTE },
      { key: "under1h", count: 1, totalMs: 24 * MINUTE },
      { key: "over1h", count: 1, totalMs: 90 * MINUTE },
    ]);
    // Active: 0–2 and 5–6; the last two turns are single requests. Idle runs to now.
    expect(activity.activeMs).toBe(3 * MINUTE);
    expect(activity.idleMs).toBe(127 * MINUTE);
    expect(activity.ongoingIdleMs).toBe(10 * MINUTE);
    expect(activity.partial).toBe(false);
  });

  it("says when the journal holds fewer requests than the session made", () => {
    const activity = summarizeSessionActivity({
      requests: SESSION.slice(3),
      sessionRequests: 8,
      busy: true,
      nowMs: T0 + 130 * MINUTE,
    })!;
    expect(activity.partial).toBe(true);
    expect(activity.ongoingIdleMs).toBe(0);
  });
});

describe("compareCacheStrategies", () => {
  it("covers each gap only when the window or its warm-ups reach it", () => {
    const activity = summarizeSessionActivity({
      requests: SESSION,
      sessionRequests: undefined,
      busy: false,
      nowMs: T0 + 120 * MINUTE,
    })!;
    const price = createRequestPricer({ fallbackModel: "claude-opus-5-5", fallbackTtl: "5m" });
    const costs = compareCacheStrategies({ requests: SESSION, gaps: activity.gaps, price });
    const byKey = Object.fromEntries(costs.map((cost) => [cost.key, cost]));
    // 100k on Opus 5.5 at $4/MTok: a read is $0.02, a 5m write $0.50, a 1h write $0.80.
    expect(byKey["5m"]!.covered).toBe(1);
    expect(byKey["5m"]!.returnsUsd).toBeCloseTo(0.02 + 0.5 + 0.5, 9);
    // 24 min needs 5 warm-ups (4-min steps past the 5-min window); 90 min passes the cap of 10.
    expect(byKey["5m-warm"]!.covered).toBe(2);
    expect(byKey["5m-warm"]!.returnsUsd).toBeCloseTo(0.02 + 6 * 0.02 + 10 * 0.02 + 0.5, 9);
    expect(byKey["1h"]!.covered).toBe(2);
    expect(byKey["1h"]!.returnsUsd).toBeCloseTo(0.02 + 0.02 + 0.8, 9);
    expect(byKey["1h-warm"]!.covered).toBe(3);
    expect(byKey["1h-warm"]!.returnsUsd).toBeCloseTo(0.02 + 0.02 + 2 * 0.02, 9);
    // The first turn's 100k write, priced at each window's rate.
    expect(byKey["5m"]!.writesUsd).toBeCloseTo(0.5, 9);
    expect(byKey["1h"]!.writesUsd).toBeCloseTo(0.8, 9);
  });
});
