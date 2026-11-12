import { getPortForwardController } from "./controller";
import type { PortForwardController } from "./types";

/**
 * Server browser tabs with forwards on this device, per host. A server tab lives on the daemon,
 * not in a webview here, so nothing unregisters it when it ends; the tab list does instead.
 */
const forwardedTabs = new Map<string, Set<string>>();

export function rememberServerTabForward(serverId: string, browserId: string): void {
  let tabs = forwardedTabs.get(serverId);
  if (!tabs) {
    tabs = new Set();
    forwardedTabs.set(serverId, tabs);
  }
  tabs.add(browserId);
}

interface ServerTabState {
  browserId: string;
  suspended?: boolean;
}

/**
 * Forwards belong to the tab: stops those of every tab the host no longer lists (closed, crashed,
 * the server browser turned off) or lists as suspended (its page unloaded).
 */
export function stopForwardsOfEndedServerTabs(
  serverId: string,
  tabs: readonly ServerTabState[],
  controller: PortForwardController | null = getPortForwardController(),
): string[] {
  const forwarded = forwardedTabs.get(serverId);
  if (!forwarded || !controller) return [];
  const live = new Set(tabs.filter((tab) => tab.suspended !== true).map((tab) => tab.browserId));
  const ended = Array.from(forwarded).filter((browserId) => !live.has(browserId));
  for (const browserId of ended) {
    forwarded.delete(browserId);
    void controller.stopAll(browserId).catch(() => {});
  }
  if (forwarded.size === 0) forwardedTabs.delete(serverId);
  return ended;
}
