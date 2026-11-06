import { describe, expect, it } from "vitest";
import type { PromptCacheHistoryEntry } from "@getpaseo/protocol/agent-cache-warm";
import { resolveClaudeTokenPrices } from "@getpaseo/protocol/claude-pricing";
import {
  estimatePromptSendUsd,
  estimatePromptTokens,
  estimateTurnCostUsd,
  estimateWarmUpStretchCostUsd,
  resolveMoneyStatsPrices,
  resolveMoneyStatsPricer,
} from "./money-stats";
import { effectiveInputUsdPerMTok, summarizePromptCacheInsights } from "./prompt-cache-insights";

const T0 = Date.parse("2026-11-06T10:00:00.000Z");

function entry(
  offsetMs: number,
  kind: PromptCacheHistoryEntry["kind"],
  readTokens: number,
  writeTokens = 0,
): PromptCacheHistoryEntry {
  return {
    at: new Date(T0 + offsetMs).toISOString(),
    kind,
    readTokens,
    writeTokens,
    uncachedTokens: 0,
    gapMs: 1000,
    model: "claude-opus-5-5",
    writeTtl: "5m",
  };
}

describe("money stats", () => {
  it("prices first-party Claude models only", () => {
    expect(
      resolveMoneyStatsPrices({ provider: "claude", model: "claude-opus-5-5" }),
    ).not.toBeNull();
    expect(resolveMoneyStatsPrices({ provider: "claude", model: "opus" })).not.toBeNull();
    // A CLIProxyAPI slug and the gateway's own -dd- ids have no price table here.
    expect(resolveMoneyStatsPrices({ provider: "claude", model: "grok-4.6" })).toBeNull();
    expect(
      resolveMoneyStatsPrices({ provider: "claude", model: "claude-fable-5-dd-high" }),
    ).toBeNull();
    expect(resolveMoneyStatsPrices({ provider: "codex", model: "gpt-5.5" })).toBeNull();
  });

  it("estimates a prompt as the context the cache holds plus the prompt written at the TTL", () => {
    const prices = resolveClaudeTokenPrices("claude-opus-5-5")!;
    const base = { contextTokens: 100_000, runtimeActive: true, ttl: "5m" as const };
    // Opus 5.5: $4/MTok input, reads at 0.05×, 5m writes at 1.25×.
    const warm = estimatePromptSendUsd({
      cost: { ...base, cache: { kind: "warm", remainingMs: 1 }, warmUsd: 0.02, coldUsd: 0.5 },
      promptTokens: 1000,
      prices,
    });
    expect(warm).toBeCloseTo(0.02 + (1000 * 1.25 * 4) / 1_000_000, 9);
    const cold = estimatePromptSendUsd({
      cost: { ...base, cache: { kind: "cold" }, warmUsd: 0.02, coldUsd: 0.5 },
      promptTokens: 1000,
      prices,
    });
    expect(cold).toBeCloseTo(0.5 + 0.005, 9);
    expect(estimatePromptTokens("  ")).toBe(0);
    expect(estimatePromptTokens("abcdefghi")).toBe(3);
  });

  it("prices a turn from its own requests and a warm-up stretch from its warm-ups", () => {
    const price = resolveMoneyStatsPricer({
      agent: { provider: "claude", model: "claude-opus-5-5" },
      ttl: "5m",
    })!;
    const entries = [
      entry(-60_000, "turn", 1_000_000), // the turn before
      entry(1000, "turn", 1_000_000), // 1M reads at $0.20
      entry(2000, "warm-up", 1_000_000), // a warm-up inside the turn is not the turn's cost
      entry(3000, "request", 0, 1_000_000), // 1M written at $5
      entry(10 * 60_000, "warm-up", 1_000_000),
      entry(14 * 60_000, "warm-up", 1_000_000),
    ];
    expect(
      estimateTurnCostUsd({ entries, price, startedAtMs: T0, completedAtMs: T0 + 5000 }),
    ).toBeCloseTo(5.2, 9);
    expect(
      estimateWarmUpStretchCostUsd({
        entries,
        price,
        firstAtMs: T0 + 10 * 60_000,
        lastAtMs: T0 + 14 * 60_000,
      }),
    ).toBeCloseTo(0.4, 9);
    expect(
      estimateTurnCostUsd({ entries, price, startedAtMs: T0 + 1e9, completedAtMs: T0 + 2e9 }),
    ).toBeNull();
  });

  it("states the effective input rate as all spend over the work's input tokens", () => {
    const price = resolveMoneyStatsPricer({
      agent: { provider: "claude", model: "claude-opus-5-5" },
      ttl: "5m",
    })!;
    const insights = summarizePromptCacheInsights({
      requests: [entry(0, "turn", 0, 1_000_000), entry(60_000, "warm-up", 1_000_000)],
      compactions: [],
      cacheWindowMs: 5 * 60_000,
      price,
      nowMs: T0 + 120_000,
    });
    // $5 of work and $0.20 of warm-up over the 1M tokens the work sent.
    expect(effectiveInputUsdPerMTok(insights.cost)).toBeCloseTo(5.2, 9);
  });
});
