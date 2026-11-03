import { describe, expect, it } from "vitest";
import {
  estimateNextRequestCost,
  estimateRequestInputCostUsd,
  formatUsdEstimate,
  resolveClaudeTokenPrices,
} from "./prompt-cache-cost";

describe("resolveClaudeTokenPrices", () => {
  it("tells Opus 5.5 apart from Opus 5, whose cache reads cost twice as much", () => {
    expect(resolveClaudeTokenPrices("claude-opus-5-5")?.cacheReadMultiplier).toBe(0.05);
    expect(resolveClaudeTokenPrices("claude-opus-5")?.cacheReadMultiplier).toBe(0.1);
    expect(resolveClaudeTokenPrices("claude-opus-5")?.inputUsdPerMTok(1)).toBe(5);
  });

  it("prices the 1M-context variant and family aliases", () => {
    expect(resolveClaudeTokenPrices("claude-opus-5-5[1m]")?.inputUsdPerMTok(1)).toBe(4);
    expect(resolveClaudeTokenPrices("sonnet")?.inputUsdPerMTok(1)).toBe(2);
    expect(resolveClaudeTokenPrices("fable")?.cacheReadMultiplier).toBe(0.025);
  });

  it("charges Haiku 5.5 its higher tier once a prompt passes 100k tokens", () => {
    const haiku = resolveClaudeTokenPrices("claude-haiku-5-5");
    expect(haiku?.inputUsdPerMTok(100_000)).toBe(0.1);
    expect(haiku?.inputUsdPerMTok(100_001)).toBe(0.5);
  });

  it("knows no price for another provider's model", () => {
    expect(resolveClaudeTokenPrices("gpt-5")).toBeNull();
    expect(resolveClaudeTokenPrices(null)).toBeNull();
  });
});

describe("estimateRequestInputCostUsd", () => {
  const opus = resolveClaudeTokenPrices("claude-opus-5-5")!;

  it("bills reads, writes at the request's own TTL, and uncached input", () => {
    // 1M read at $0.20 + 100k written for 1h at $8 + 1k uncached at $4.
    const cost = estimateRequestInputCostUsd(
      { readTokens: 1_000_000, writeTokens: 100_000, uncachedTokens: 1_000, writeTtl: "1h" },
      { prices: opus, ttl: "5m" },
    );
    expect(cost).toBeCloseTo(0.2 + 0.8 + 0.004, 6);
  });

  it("falls back to the basis TTL when the request reported none", () => {
    const cost = estimateRequestInputCostUsd(
      { readTokens: 0, writeTokens: 1_000_000, uncachedTokens: 0 },
      { prices: opus, ttl: "5m" },
    );
    expect(cost).toBeCloseTo(5, 6);
  });
});

describe("estimateNextRequestCost", () => {
  it("prices a 450k Opus 5.5 context warm against cold on a 5m window", () => {
    const cost = estimateNextRequestCost(450_000, {
      prices: resolveClaudeTokenPrices("claude-opus-5-5")!,
      ttl: "5m",
    });
    expect(cost.warmUsd).toBeCloseTo(0.09, 6);
    expect(cost.coldUsd).toBeCloseTo(2.25, 6);
  });
});

describe("formatUsdEstimate", () => {
  it("keeps cents and marks amounts too small to show", () => {
    expect(formatUsdEstimate(2.25)).toBe("$2.25");
    expect(formatUsdEstimate(0.004)).toBe("<$0.01");
    expect(formatUsdEstimate(1234.4)).toBe("$1,234");
  });
});
