import { useCallback, useSyncExternalStore } from "react";
import type { AgentMessageFoldState } from "./model";

/**
 * The reader's one-by-one expand choices per agent, for this app session only. The chat reads
 * them, and the chat display menu clears them when the reader collapses or expands all.
 */
const EMPTY_STATE: AgentMessageFoldState = { toggledIds: new Set(), openGroupIds: new Set() };

const states = new Map<string, AgentMessageFoldState>();
const listeners = new Map<string, Set<() => void>>();

function keyOf(serverId: string, agentId: string): string {
  return `${serverId}\u0000${agentId}`;
}

function write(key: string, next: AgentMessageFoldState): void {
  if (next.toggledIds.size === 0 && next.openGroupIds.size === 0) states.delete(key);
  else states.set(key, next);
  for (const listener of listeners.get(key) ?? []) listener();
}

function flip(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function readAgentMessageFoldState(
  serverId: string,
  agentId: string,
): AgentMessageFoldState {
  return states.get(keyOf(serverId, agentId)) ?? EMPTY_STATE;
}

export function toggleAgentMessage(input: { serverId: string; agentId: string; id: string }): void {
  const key = keyOf(input.serverId, input.agentId);
  const current = states.get(key) ?? EMPTY_STATE;
  write(key, { ...current, toggledIds: flip(current.toggledIds, input.id) });
}

export function toggleAgentMessageGroup(input: {
  serverId: string;
  agentId: string;
  hostId: string;
}): void {
  const key = keyOf(input.serverId, input.agentId);
  const current = states.get(key) ?? EMPTY_STATE;
  write(key, { ...current, openGroupIds: flip(current.openGroupIds, input.hostId) });
}

/** Back to the display for every row: what Collapse all and Expand all do after saving it. */
export function resetAgentMessageFold(serverId: string, agentId: string): void {
  const key = keyOf(serverId, agentId);
  if (states.has(key)) write(key, EMPTY_STATE);
}

export function useAgentMessageFoldState(serverId: string, agentId: string): AgentMessageFoldState {
  const key = keyOf(serverId, agentId);
  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(() => states.get(key) ?? EMPTY_STATE, [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
