import { useCallback } from "react";
import {
  CACHE_AUTO_COMPACT_FEATURE_ID,
  CACHE_AUTO_COMPACT_MIN_CONTEXT_TOKENS,
  promptCacheInputTokens,
  resolveCacheAutoCompactEnabled,
} from "@getpaseo/protocol/agent-cache-warm";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Agent } from "@/stores/session-store";
import { usePromptCacheAgent } from "./use-prompt-cache";

export interface PromptCacheAutoCompact {
  /** Compact instead of expiring at the warm-up idle cap. */
  enabled: boolean;
  /** Whether the agent's own choice decides, rather than the host default. */
  overridden: boolean;
  /** Context the cache holds now; null before any request. */
  contextTokens: number | null;
  /** The context is large enough that the cap would compact rather than expire. */
  largeEnough: boolean;
}

/** Pure for tests: what the pill shows about compacting at the cap. */
export function resolvePromptCacheAutoCompact(input: {
  agent: Pick<Agent, "cacheAutoCompact" | "promptCache"> | undefined;
  hostDefault: boolean | undefined;
}): PromptCacheAutoCompact {
  const lastRequest = input.agent?.promptCache?.lastRequest;
  const contextTokens = lastRequest ? promptCacheInputTokens(lastRequest) : null;
  return {
    enabled: resolveCacheAutoCompactEnabled({
      explicitValue: input.agent?.cacheAutoCompact,
      hostDefault: input.hostDefault,
    }),
    overridden: typeof input.agent?.cacheAutoCompact === "boolean",
    contextTokens,
    largeEnough: contextTokens !== null && contextTokens >= CACHE_AUTO_COMPACT_MIN_CONTEXT_TOKENS,
  };
}

/** Kept apart from usePromptCache so only the pill subscribes to the host config. */
export function usePromptCacheAutoCompact(
  serverId: string,
  agentId: string,
): PromptCacheAutoCompact & { toggle: () => Promise<void> } {
  const client = useHostRuntimeClient(serverId);
  const agent = usePromptCacheAgent(serverId, agentId);
  const { config } = useDaemonConfig(serverId);
  const state = resolvePromptCacheAutoCompact({ agent, hostDefault: config?.cacheAutoCompact });
  const { enabled } = state;
  const toggle = useCallback(async () => {
    if (!client) return;
    await client.setAgentFeature(agentId, CACHE_AUTO_COMPACT_FEATURE_ID, !enabled);
  }, [client, agentId, enabled]);
  return { ...state, toggle };
}
