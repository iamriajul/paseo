import { useEffect, useMemo, useState } from "react";
import { isSideQuestionAgent } from "@getpaseo/protocol/agent-labels";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { resolvePromptCacheExpiresAtMs } from "./use-prompt-cache";

export interface WarmCacheWorkspaces {
  /** `serverId:workspaceId` of every workspace with at least one agent whose cache is warm. */
  keys: ReadonlySet<string>;
  /** When the set next shrinks: the soonest of those workspaces to go cold. Null when none is warm. */
  nextExpiryMs: number | null;
}

export function warmCacheWorkspaceKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

/**
 * When each workspace's warmest cache expires. Any agent counts, not only the workspace's active
 * one: a child or a second chat holds a cache that costs as much to lose. Archived agents and side
 * questions do not; a side question has no warm-up and reads the main chat's cache.
 */
export function indexWorkspaceCacheExpiry(
  hosts: ReadonlyArray<{ serverId: string; agents: Iterable<Agent> }>,
): Map<string, number> {
  const expiry = new Map<string, number>();
  for (const host of hosts) {
    for (const agent of host.agents) {
      if (agent.archivedAt || !agent.workspaceId || isSideQuestionAgent(agent)) continue;
      const expiresAtMs = resolvePromptCacheExpiresAtMs(agent);
      if (expiresAtMs === null) continue;
      const key = warmCacheWorkspaceKey(host.serverId, agent.workspaceId);
      expiry.set(key, Math.max(expiry.get(key) ?? expiresAtMs, expiresAtMs));
    }
  }
  return expiry;
}

export function selectWarmCacheWorkspaces(
  expiry: ReadonlyMap<string, number>,
  nowMs: number,
): WarmCacheWorkspaces {
  const keys = new Set<string>();
  let nextExpiryMs: number | null = null;
  for (const [key, expiresAtMs] of expiry) {
    if (expiresAtMs <= nowMs) continue;
    keys.add(key);
    if (nextExpiryMs === null || expiresAtMs < nextExpiryMs) nextExpiryMs = expiresAtMs;
  }
  return { keys, nextExpiryMs };
}

/**
 * One host's index per `agents` map. The store replaces the map when an agent changes, so a host
 * is re-indexed only then, not on every store update the selector below runs for.
 */
const expiryByAgents = new WeakMap<ReadonlyMap<string, Agent>, Map<string, number>>();

function hostExpiry(serverId: string, agents: ReadonlyMap<string, Agent>): Map<string, number> {
  const cached = expiryByAgents.get(agents);
  if (cached) return cached;
  const expiry = indexWorkspaceCacheExpiry([{ serverId, agents: agents.values() }]);
  expiryByAgents.set(agents, expiry);
  return expiry;
}

const NO_WARM_WORKSPACES: WarmCacheWorkspaces = { keys: new Set(), nextExpiryMs: null };

/**
 * The warm-cache workspaces across every connected host. The selector returns a string, so the
 * caller re-renders only when the set changes, and a timer re-reads it when the soonest cache
 * expires; nothing ticks each second.
 */
export function useWarmCacheWorkspaces(enabled: boolean): WarmCacheWorkspaces {
  "use no memo";
  const [, setExpiryTick] = useState(0);
  const signature = useSessionStore((state) => {
    if (!enabled) return "";
    const expiry = new Map<string, number>();
    for (const [serverId, session] of Object.entries(state.sessions)) {
      for (const [key, expiresAtMs] of hostExpiry(serverId, session.agents)) {
        expiry.set(key, expiresAtMs);
      }
    }
    const warm = selectWarmCacheWorkspaces(expiry, Date.now());
    return JSON.stringify([warm.nextExpiryMs, [...warm.keys].sort()]);
  });
  const warm = useMemo((): WarmCacheWorkspaces => {
    if (!signature) return NO_WARM_WORKSPACES;
    const [nextExpiryMs, keys] = JSON.parse(signature) as [number | null, string[]];
    return { keys: new Set(keys), nextExpiryMs };
  }, [signature]);
  useEffect(() => {
    if (warm.nextExpiryMs === null) return;
    const timeout = setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.max(0, warm.nextExpiryMs - Date.now()) + 50,
    );
    return () => clearTimeout(timeout);
  }, [warm.nextExpiryMs]);
  return warm;
}
