import type { PromptCacheRequestTokens, PromptCacheTtl } from "@getpaseo/protocol/agent-cache-warm";

/**
 * Anthropic first-party list prices, used to estimate what cache traffic costs. A subscription or
 * a gateway bills differently, so every figure built on these is labelled an API-price estimate.
 * Source: the Claude API model table (cached 2026-10-06) and the prompt-caching page.
 */
export interface ClaudeTokenPrices {
  /** USD per million uncached input tokens, for a prompt of the given size. */
  inputUsdPerMTok: (promptTokens: number) => number;
  outputUsdPerMTok: (promptTokens: number) => number;
  /** A cache read's price as a share of the input price. It differs by model. */
  cacheReadMultiplier: number;
}

/** A cache write's price as a share of the input price, by the TTL it was written at. */
export const CACHE_WRITE_MULTIPLIER: Record<PromptCacheTtl, number> = { "5m": 1.25, "1h": 2 };

function flat(input: number, output: number, cacheReadMultiplier: number): ClaudeTokenPrices {
  return {
    inputUsdPerMTok: () => input,
    outputUsdPerMTok: () => output,
    cacheReadMultiplier,
  };
}

/** Haiku 5.5 charges five times as much once a prompt passes 100k tokens. */
const HAIKU_5_5_TIER_TOKENS = 100_000;
const HAIKU_5_5: ClaudeTokenPrices = {
  inputUsdPerMTok: (promptTokens) => (promptTokens > HAIKU_5_5_TIER_TOKENS ? 0.5 : 0.1),
  outputUsdPerMTok: (promptTokens) => (promptTokens > HAIKU_5_5_TIER_TOKENS ? 2.5 : 0.5),
  cacheReadMultiplier: 0.1,
};

/** Longest match first: `claude-opus-5-5` must not resolve as `claude-opus-5`. */
const PRICES_BY_MODEL: ReadonlyArray<readonly [string, ClaudeTokenPrices]> = [
  ["fable-5-1", flat(10, 50, 0.025)],
  ["mythos-5-1", flat(10, 50, 0.025)],
  ["fable-5", flat(10, 50, 0.1)],
  ["mythos-5", flat(10, 50, 0.1)],
  ["opus-5-5", flat(4, 20, 0.05)],
  ["opus-5", flat(5, 25, 0.1)],
  ["opus-4", flat(5, 25, 0.1)],
  ["sonnet-5-5", flat(2, 10, 0.1)],
  ["sonnet-5", flat(2, 10, 0.1)],
  ["sonnet-4", flat(3, 15, 0.1)],
  ["haiku-5-5", HAIKU_5_5],
  ["haiku-4", flat(1, 5, 0.1)],
];

/** Claude Code's family aliases resolve to the current model of that family. */
const ALIAS_TO_MODEL: Record<string, string> = {
  fable: "fable-5-1",
  opus: "opus-5-5",
  sonnet: "sonnet-5-5",
  haiku: "haiku-5-5",
};

/** Prices for a Claude model id or alias; null when the model is not one we know a price for. */
export function resolveClaudeTokenPrices(
  modelId: string | null | undefined,
): ClaudeTokenPrices | null {
  if (!modelId) return null;
  // `claude-opus-5-5[1m]` names the 1M-context variant, which is priced the same.
  const normalized = modelId
    .trim()
    .toLowerCase()
    .replace(/\[.*\]$/, "");
  const key = ALIAS_TO_MODEL[normalized] ?? normalized;
  for (const [fragment, prices] of PRICES_BY_MODEL) {
    if (key.includes(fragment)) return prices;
  }
  return null;
}

export interface CacheCostBasis {
  prices: ClaudeTokenPrices;
  /** TTL a write is billed at when the request did not report one. */
  ttl: PromptCacheTtl;
}

/**
 * Estimated input cost of one request in USD: reads at the cache-read price, writes at the write
 * price of their TTL, the rest at the input price. Output is not recorded per request, so it is
 * not in this figure.
 */
export function estimateRequestInputCostUsd(
  tokens: PromptCacheRequestTokens,
  basis: CacheCostBasis,
): number {
  const promptTokens = tokens.readTokens + tokens.writeTokens + tokens.uncachedTokens;
  const input = basis.prices.inputUsdPerMTok(promptTokens);
  const writeMultiplier = CACHE_WRITE_MULTIPLIER[tokens.writeTtl ?? basis.ttl];
  const units =
    tokens.readTokens * basis.prices.cacheReadMultiplier +
    tokens.writeTokens * writeMultiplier +
    tokens.uncachedTokens;
  return (units * input) / 1_000_000;
}

/** What the next request costs to send a context of this size, warm or cold. */
export interface NextRequestCost {
  /** Reading the whole context from a live cache. */
  warmUsd: number;
  /** Writing the whole context again after the cache expired. */
  coldUsd: number;
}

export function estimateNextRequestCost(
  contextTokens: number,
  basis: CacheCostBasis,
): NextRequestCost {
  return {
    warmUsd: estimateRequestInputCostUsd(
      { readTokens: contextTokens, writeTokens: 0, uncachedTokens: 0 },
      basis,
    ),
    coldUsd: estimateRequestInputCostUsd(
      { readTokens: 0, writeTokens: contextTokens, uncachedTokens: 0 },
      basis,
    ),
  };
}

export function formatUsdEstimate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return "<$0.01";
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}
