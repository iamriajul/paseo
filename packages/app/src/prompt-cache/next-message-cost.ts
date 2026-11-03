import {
  FIVE_MINUTE_CACHE_WINDOW_MS,
  promptCacheInputTokens,
  type PromptCacheTtl,
} from "@getpaseo/protocol/agent-cache-warm";
import type { Agent } from "@/stores/session-store";
import { estimateNextRequestCost, resolveClaudeTokenPrices } from "./prompt-cache-cost";
import type { PromptCacheView } from "./use-prompt-cache";

/** Whether the next message finds the context in the cache. */
export type NextMessageCache =
  | { kind: "warm"; remainingMs: number }
  | { kind: "cold" }
  /** Automatic window with no write seen yet: the expiry is not known. */
  | { kind: "unknown" };

/** What sending the next message would cost, so a stopped or idle agent can be judged. */
export interface NextMessageCost {
  contextTokens: number;
  cache: NextMessageCache;
  /** Claude Code is running; false once the process stopped, so the next message starts it. */
  runtimeActive: boolean | null;
  warmUsd: number;
  coldUsd: number;
  ttl: PromptCacheTtl;
}

function resolveCache(view: PromptCacheView): NextMessageCache {
  switch (view.status.kind) {
    case "automatic":
      return { kind: "unknown" };
    case "expired":
    case "busy-expired":
      return { kind: "cold" };
    case "busy":
      return view.status.remainingMs === null
        ? { kind: "unknown" }
        : { kind: "warm", remainingMs: view.status.remainingMs };
    case "warm":
    case "awaiting-question":
    case "awaiting-permission":
      return { kind: "warm", remainingMs: view.status.remainingMs };
  }
}

/**
 * The context the next request sends: what the last request sent, which is exactly what sits in
 * the cache, else the provider's last context report.
 */
function resolveContextTokens(agent: Agent): number | null {
  const lastRequest = agent.promptCache?.lastRequest;
  if (lastRequest) {
    const tokens = promptCacheInputTokens(lastRequest);
    if (tokens > 0) return tokens;
  }
  return agent.lastUsage?.contextWindowUsedTokens ?? null;
}

export function resolveNextMessageCost(input: {
  agent: Agent | undefined;
  view: PromptCacheView;
}): NextMessageCost | null {
  const { agent, view } = input;
  if (!agent || !view.isClaude) return null;
  const prices = resolveClaudeTokenPrices(agent.model ?? agent.runtimeInfo?.model);
  const contextTokens = resolveContextTokens(agent);
  if (!prices || contextTokens === null || contextTokens <= 0) return null;
  // A write is billed at the window it is written for; an unknown window is treated as 5m, the
  // cheaper write, so the cold figure is never overstated.
  const ttl: PromptCacheTtl =
    view.windows && view.windows.cacheWindowMs > FIVE_MINUTE_CACHE_WINDOW_MS ? "1h" : "5m";
  const cost = estimateNextRequestCost(contextTokens, { prices, ttl });
  return {
    contextTokens,
    cache: resolveCache(view),
    runtimeActive: typeof agent.runtimeActive === "boolean" ? agent.runtimeActive : null,
    warmUsd: cost.warmUsd,
    coldUsd: cost.coldUsd,
    ttl,
  };
}
