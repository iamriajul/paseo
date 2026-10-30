import type { PromptCacheStatus } from "./use-prompt-cache";

export type CacheWindowChange = { kind: "apply" } | { kind: "confirm"; remainingMs: number };

/** Time left on a cache that is live now, or null when no live cache has time left. */
export function liveCacheRemainingMs(status: PromptCacheStatus): number | null {
  switch (status.kind) {
    case "warm":
    case "awaiting-question":
    case "awaiting-permission":
    case "busy":
      return status.remainingMs;
    case "automatic":
    case "busy-expired":
    case "expired":
      return null;
  }
}

/**
 * A Cache window change waits for confirmation only while a live cache has time left, because
 * that is the cache the change could cost the user. With nothing live, the change applies at once.
 */
export function resolveCacheWindowChange(input: { status: PromptCacheStatus }): CacheWindowChange {
  const remainingMs = liveCacheRemainingMs(input.status);
  return remainingMs === null ? { kind: "apply" } : { kind: "confirm", remainingMs };
}

/** A Cache window change held for confirmation, kept with the agent it was asked for. */
export interface PendingCacheWindowChange {
  agentId: string;
  featureId: string;
  value: unknown;
}

/** Returns the pending change only for the agent it was asked for, never for another agent. */
export function pendingChangeForAgent(
  pending: PendingCacheWindowChange | null,
  agentId: string,
): PendingCacheWindowChange | null {
  return pending?.agentId === agentId ? pending : null;
}
