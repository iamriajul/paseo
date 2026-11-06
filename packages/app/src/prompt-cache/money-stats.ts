import {
  CACHE_WRITE_MULTIPLIER,
  resolveClaudeTokenPrices,
  type ClaudeTokenPrices,
} from "@getpaseo/protocol/claude-pricing";
import {
  FIVE_MINUTE_CACHE_WINDOW_MS,
  isClaudeModel,
  type PromptCacheHistoryEntry,
  type PromptCacheTtl,
  type PromptCacheWindows,
} from "@getpaseo/protocol/agent-cache-warm";
import type { Agent } from "@/stores/session-store";
import { createRequestPricer, type RequestPricer } from "./prompt-cache-insights";
import type { NextMessageCost } from "./next-message-cost";

/**
 * Money figures are API list-price estimates for first-party Claude models in claude-pricing.ts.
 * Any other model has no price table here: a CLIProxyAPI gateway slug, or the gateway's own
 * `-dd-` ids, only pass through what upstream reports, which says nothing about Claude's prices.
 */
export function resolveMoneyStatsPrices(
  agent: Pick<Agent, "provider" | "model" | "runtimeInfo"> | undefined,
): ClaudeTokenPrices | null {
  if (!agent || agent.provider !== "claude") return null;
  const model = agent.model ?? agent.runtimeInfo?.model;
  if (!isClaudeModel(model)) return null;
  return resolveClaudeTokenPrices(model);
}

/** The TTL a write is billed at: a window over 5 minutes is 1h; an unknown one is the cheaper 5m. */
export function resolveWriteTtl(windows: PromptCacheWindows | null): PromptCacheTtl {
  return windows && windows.cacheWindowMs > FIVE_MINUTE_CACHE_WINDOW_MS ? "1h" : "5m";
}

/** Prices each request of a priced agent; null when money figures do not apply to it. */
export function resolveMoneyStatsPricer(input: {
  agent: Pick<Agent, "provider" | "model" | "runtimeInfo"> | undefined;
  ttl: PromptCacheTtl;
}): RequestPricer | null {
  if (!resolveMoneyStatsPrices(input.agent)) return null;
  return createRequestPricer({
    fallbackModel: input.agent?.model ?? input.agent?.runtimeInfo?.model,
    fallbackTtl: input.ttl,
  });
}

/** Rough tokens for typed text: about four characters a token for English prose and code. */
export function estimatePromptTokens(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : Math.ceil(trimmed.length / 4);
}

/**
 * What sending this prompt costs on input: the context as the cache finds it (a read while
 * warm, a full write once expired or unknown) plus the typed prompt, which is written to the cache
 * at the current TTL's write price.
 */
export function estimatePromptSendUsd(input: {
  cost: NextMessageCost;
  promptTokens: number;
  prices: ClaudeTokenPrices;
}): number {
  const { cost, promptTokens, prices } = input;
  const contextUsd = cost.cache.kind === "warm" ? cost.warmUsd : cost.coldUsd;
  const promptSize = cost.contextTokens + promptTokens;
  const promptUsd =
    (promptTokens * CACHE_WRITE_MULTIPLIER[cost.ttl] * prices.inputUsdPerMTok(promptSize)) /
    1_000_000;
  return contextUsd + promptUsd;
}

function sumPriced(
  entries: readonly PromptCacheHistoryEntry[],
  price: RequestPricer,
  include: (entry: PromptCacheHistoryEntry, atMs: number) => boolean,
): number | null {
  let total = 0;
  let priced = 0;
  for (const entry of entries) {
    const atMs = Date.parse(entry.at);
    if (!Number.isFinite(atMs) || !include(entry, atMs)) continue;
    const usd = price(entry);
    if (usd === null) continue;
    total += usd;
    priced += 1;
  }
  return priced > 0 ? total : null;
}

/** A finished turn's input cost: the agent's own requests between its start and its end. */
export function estimateTurnCostUsd(input: {
  entries: readonly PromptCacheHistoryEntry[];
  price: RequestPricer;
  startedAtMs: number;
  completedAtMs: number;
}): number | null {
  const { startedAtMs, completedAtMs } = input;
  return sumPriced(
    input.entries,
    input.price,
    (entry, atMs) => entry.kind !== "warm-up" && atMs >= startedAtMs && atMs <= completedAtMs,
  );
}

/** What one idle stretch's warm-ups cost on input. */
export function estimateWarmUpStretchCostUsd(input: {
  entries: readonly PromptCacheHistoryEntry[];
  price: RequestPricer;
  firstAtMs: number;
  lastAtMs: number;
}): number | null {
  const { firstAtMs, lastAtMs } = input;
  return sumPriced(
    input.entries,
    input.price,
    (entry, atMs) => entry.kind === "warm-up" && atMs >= firstAtMs && atMs <= lastAtMs,
  );
}
