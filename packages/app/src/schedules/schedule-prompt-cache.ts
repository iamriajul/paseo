import {
  CACHE_WARM_FEATURE_ID,
  isClaudeModel,
  isPromptCacheTtl,
  PROMPT_CACHE_TTL_FEATURE_ID,
  resolveCacheWarmEnabled,
  type PromptCacheTtl,
} from "@getpaseo/protocol/agent-cache-warm";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";

/** "default" is Automatic: Claude Code picks the window, and warm-up is unavailable. */
export type SchedulePromptCacheTtl = PromptCacheTtl | "default";

export interface SchedulePromptCacheChoice {
  ttl: SchedulePromptCacheTtl;
  /** Null follows the window's default: on for 5m, off for 1h. */
  warmUp: boolean | null;
}

export function readPromptCacheChoice(
  featureValues: Record<string, unknown> | undefined,
): SchedulePromptCacheChoice {
  const ttl = featureValues?.[PROMPT_CACHE_TTL_FEATURE_ID];
  const warmUp = featureValues?.[CACHE_WARM_FEATURE_ID];
  return {
    ttl: isPromptCacheTtl(ttl) ? ttl : "default",
    warmUp: typeof warmUp === "boolean" ? warmUp : null,
  };
}

export function resolvePromptCacheWarmUp(choice: SchedulePromptCacheChoice): boolean {
  return resolveCacheWarmEnabled({ promptCacheTtl: choice.ttl, explicitValue: choice.warmUp });
}

/** The cache controls exist only for first-party Claude models, as on a live agent. */
export function supportsPromptCacheChoice(
  provider: AgentProvider | null,
  modelId: string,
): boolean {
  return provider === "claude" && isClaudeModel(modelId.trim() || null);
}

/**
 * Feature values to store on the schedule: the stored ones with the two cache keys replaced.
 * Automatic, or a model without the controls, stores neither key. A chosen window stores the
 * warm-up as an explicit value, so the run does not depend on a default that may change.
 */
export function applyPromptCacheChoice(input: {
  base: Record<string, unknown> | undefined;
  choice: SchedulePromptCacheChoice;
  supported: boolean;
}): Record<string, unknown> {
  const {
    [PROMPT_CACHE_TTL_FEATURE_ID]: _ttl,
    [CACHE_WARM_FEATURE_ID]: _warmUp,
    ...rest
  } = input.base ?? {};
  if (!input.supported || input.choice.ttl === "default") {
    return rest;
  }
  return {
    ...rest,
    [PROMPT_CACHE_TTL_FEATURE_ID]: input.choice.ttl,
    [CACHE_WARM_FEATURE_ID]: resolvePromptCacheWarmUp(input.choice),
  };
}
