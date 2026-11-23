/**
 * Opening chat find from outside the chat: the compact header menu has no keyboard
 * shortcut to send, so it asks the chat on screen to open its find bar. The request is
 * dropped when no chat for that agent is mounted and active.
 */
type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

function keyOf(serverId: string, agentId: string): string {
  return `${serverId}\u0000${agentId}`;
}

export function requestChatFind(serverId: string, agentId: string): void {
  listeners.get(keyOf(serverId, agentId))?.forEach((listener) => listener());
}

export function onChatFindRequest(
  serverId: string,
  agentId: string,
  listener: Listener,
): () => void {
  const key = keyOf(serverId, agentId);
  const set = listeners.get(key) ?? new Set<Listener>();
  listeners.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}
