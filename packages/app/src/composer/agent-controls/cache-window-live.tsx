import React, { createContext, type ReactElement, type ReactNode } from "react";
import { liveCacheRemainingMs } from "@/prompt-cache/cache-window-change";
import { usePromptCache } from "@/prompt-cache/use-prompt-cache";

/** Whether the agent's cache is live now. Drives the warm tone on the Cache window icon. */
export const CacheWindowLiveContext = createContext(false);

/**
 * Provides the live flag from the cache clock. Only this provider re-renders on each tick, so
 * the children it wraps keep their identity and re-render only when the flag flips.
 */
export function CacheWindowLiveProvider({
  serverId,
  agentId,
  children,
}: {
  serverId: string;
  agentId: string;
  children: ReactNode;
}): ReactElement {
  const { status } = usePromptCache(serverId, agentId);
  const live = liveCacheRemainingMs(status) !== null;
  return <CacheWindowLiveContext.Provider value={live}>{children}</CacheWindowLiveContext.Provider>;
}
