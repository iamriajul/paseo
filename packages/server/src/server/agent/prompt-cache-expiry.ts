import {
  resolvePromptCacheAnchorMs,
  resolvePromptCacheExpiresAtMs,
  type CacheExpiryStopPolicy,
  type PromptCacheTtl,
} from "@getpaseo/protocol/agent-cache-warm";
import { CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID } from "./providers/claude/feature-definitions.js";

/** The fields a loaded agent and its stored record share. */
export interface PromptCacheExpiryView {
  provider: string;
  config?: { model?: string | null; featureValues?: Record<string, unknown> | null } | null;
  runtimeInfo?: { model?: string | null } | null;
  promptCache?: { lastRequest: { at: string }; observedTtl?: PromptCacheTtl } | null;
  lastResponseAt?: Date | string | null;
}

export function resolveAgentPromptCacheExpiresAtMs(agent: PromptCacheExpiryView): number | null {
  return resolvePromptCacheExpiresAtMs({
    provider: agent.provider,
    modelId: agent.config?.model ?? agent.runtimeInfo?.model,
    promptCacheTtl: agent.config?.featureValues?.[CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID],
    observedTtl: agent.promptCache?.observedTtl,
    anchorMs: resolvePromptCacheAnchorMs(agent),
  });
}

/**
 * Whether an automatic wake-up (a heartbeat, a schedule, a boot resume) must leave the agent
 * asleep: its cache has expired, so the wake-up would write the whole context again at full price.
 */
export function shouldSkipWakeForExpiredCache(input: {
  agent: PromptCacheExpiryView;
  policy: CacheExpiryStopPolicy;
  nowMs: number;
}): boolean {
  if (input.policy === "off") return false;
  const expiresAt = resolveAgentPromptCacheExpiresAtMs(input.agent);
  return expiresAt !== null && input.nowMs >= expiresAt;
}
