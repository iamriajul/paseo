import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { collectAllTabs, findPaneById } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useServerBrowserStore, type ServerBrowserTab } from "./store";

/**
 * The host's tab list is the one source of which server tabs a workspace has, so every client
 * shows the same set: a tab any client, agent or page opens appears on every client, and a tab
 * the host closes leaves every client. What stays per client is the layout around them (the
 * order, the pane, which tab is in front), because the rest of the tab strip (agents, terminals,
 * files, desktop Browser tabs) is per client too. See docs/server-browser.md, "Viewing".
 */

type Layout = ReturnType<typeof useWorkspaceLayoutStore.getState>["layoutByWorkspace"][string];

// Tabs this client asked the host to close and the host has not answered for. A list sent before
// the close landed still holds them, and must not bring them back.
const closing = new Set<string>();
// Workspaces where this client has an open in flight: the host may list the new tab before it
// answers with its id, and the opener places that tab itself, in front.
const opening = new Map<string, number>();
// The host's last list per host, so a tab that leaves it leaves the layout.
const known = new Map<string, Map<string, string>>();

/**
 * Brings this client's layouts in line with one host's tab list: opens the tabs a layout lacks,
 * closes the ones the host ended, and copies each tab's pin. `snapshot`: the list is the host's
 * whole set after a (re)connect, so a server tab a saved layout still holds and the host no longer
 * has closed while this client was away.
 */
export function reconcileHostTabs(
  serverId: string,
  tabs: readonly ServerBrowserTab[],
  options: { snapshot: boolean; keepsPins: boolean },
): void {
  removeEndedTabs(serverId, tabs, options.snapshot);
  for (const tab of tabs) placeTab(serverId, tab);
  if (options.keepsPins) for (const tab of tabs) copyPin(serverId, tab);
}

/**
 * Opens a server tab on the host for this client and places it with `place` (in front, or in
 * place of the launcher tab). Other clients place it in the background through their tab lists.
 */
export async function openHostTab(input: {
  client: Pick<DaemonClient, "serverBrowserOpenTab">;
  serverId: string;
  workspaceId: string;
  url: string;
  place: (target: { kind: "server_browser"; browserId: string }) => void;
}): Promise<string> {
  const key = `${input.serverId}:${input.workspaceId}`;
  opening.set(key, (opening.get(key) ?? 0) + 1);
  try {
    const browserId = await input.client.serverBrowserOpenTab(input.workspaceId, input.url);
    input.place({ kind: "server_browser", browserId });
    return browserId;
  } finally {
    const left = (opening.get(key) ?? 1) - 1;
    if (left > 0) opening.set(key, left);
    else opening.delete(key);
    // A tab another client opened meanwhile waited for this open to finish.
    reconcileCurrent(input.serverId);
  }
}

/** Marks a tab this client is closing on the host until the host answers. */
export function trackHostTabClose(serverId: string, browserId: string, close: Promise<unknown>) {
  const key = `${serverId}:${browserId}`;
  closing.add(key);
  void close
    .catch(() => undefined)
    .finally(() => {
      closing.delete(key);
      // A refused close (a pinned tab, a lost connection) leaves the tab on the host, so it
      // comes back here.
      reconcileCurrent(serverId);
    });
}

function reconcileCurrent(serverId: string): void {
  const host = useServerBrowserStore.getState().hosts[serverId];
  if (!host) return;
  reconcileHostTabs(serverId, host.tabs, { snapshot: false, keepsPins: false });
}

function placeTab(serverId: string, tab: ServerBrowserTab): void {
  if (closing.has(`${serverId}:${tab.browserId}`)) return;
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId: tab.workspaceId });
  if (!workspaceKey) return;
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  if (layoutTabIds(layout, tab.browserId).length > 0) return;
  const opener = tab.openerBrowserId;
  if (!opener && tab.openedBy === "user" && opening.has(`${serverId}:${tab.workspaceId}`)) return;
  // A popup opens next to its opener, in front on the client whose focused tab is the opener
  // (the one that clicked, as in a browser); every other tab opens in the background.
  const openerTabId = opener ? layoutTabIds(layout, opener)[0] : undefined;
  store.openTab({
    workspaceKey,
    target: { kind: "server_browser", browserId: tab.browserId },
    intent: opener && isFocusedTab(layout, openerTabId) ? "new" : "background",
    ...(openerTabId ? { parentTabId: openerTabId } : {}),
  });
}

function copyPin(serverId: string, tab: ServerBrowserTab): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId: tab.workspaceId });
  if (!workspaceKey) return;
  const store = useWorkspaceLayoutStore.getState();
  for (const tabId of layoutTabIds(store.layoutByWorkspace[workspaceKey], tab.browserId)) {
    store.setTabPinned(workspaceKey, tabId, tab.pinned === true);
  }
}

function removeEndedTabs(
  serverId: string,
  tabs: readonly ServerBrowserTab[],
  snapshot: boolean,
): void {
  const previous = known.get(serverId) ?? new Map<string, string>();
  const current = new Map(tabs.map((tab) => [tab.browserId, tab.workspaceId] as const));
  known.set(serverId, current);
  const store = useWorkspaceLayoutStore.getState();
  for (const [workspaceKey, layout] of Object.entries(store.layoutByWorkspace)) {
    if (!workspaceKey.startsWith(`${serverId}:`)) continue;
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.target.kind !== "server_browser" || current.has(tab.target.browserId)) continue;
      if (snapshot || previous.has(tab.target.browserId)) closeEndedTab(workspaceKey, tab.tabId);
    }
  }
}

/** The host ended the tab, so a pin has nothing left to keep: it goes with the tab. */
function closeEndedTab(workspaceKey: string, tabId: string): void {
  const store = useWorkspaceLayoutStore.getState();
  store.setTabPinned(workspaceKey, tabId, false);
  store.closeTab(workspaceKey, tabId);
}

/**
 * Tabs showing the server tab. Its id is deterministic when the sync placed it and random when
 * this client opened it in front, so the target, not the id, finds it.
 */
function layoutTabIds(layout: Layout | undefined, browserId: string): string[] {
  if (!layout) return [];
  return collectAllTabs(layout.root)
    .filter((tab) => tab.target.kind === "server_browser" && tab.target.browserId === browserId)
    .map((tab) => tab.tabId);
}

function isFocusedTab(layout: Layout | undefined, tabId: string | undefined): boolean {
  if (!layout || !tabId) return false;
  const pane = findPaneById(layout.root, layout.focusedPaneId);
  return pane?.hidden !== true && pane?.focusedTabId === tabId;
}

/** Forgets the host's list, for tests. */
export function resetHostTabsForTests(): void {
  closing.clear();
  opening.clear();
  known.clear();
}
