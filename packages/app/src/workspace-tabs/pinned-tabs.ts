import type { SplitNode } from "@/stores/workspace-layout-actions";

/**
 * Pinned workspace tabs, by workspace key then tab id. A pinned tab cannot be closed until it is
 * unpinned: not by its close button, middle-click, Cmd/Ctrl+W, a bulk close, a pane close, or the
 * reconcile that removes tabs whose agent was archived or whose terminal is gone.
 *
 * Unrelated to `pinnedAgentIdsByWorkspace` in the layout store, which keeps an explicitly opened
 * agent visible while it is archived and is never shown to the user as a pin.
 */
export type PinnedTabIdsByWorkspace = Record<string, ReadonlySet<string>>;

export function isTabPinned(
  pinned: PinnedTabIdsByWorkspace,
  workspaceKey: string,
  tabId: string,
): boolean {
  return pinned[workspaceKey]?.has(tabId) ?? false;
}

export function withTabPinned(
  pinned: PinnedTabIdsByWorkspace,
  workspaceKey: string,
  tabId: string,
  value: boolean,
): PinnedTabIdsByWorkspace {
  const current = pinned[workspaceKey];
  if ((current?.has(tabId) ?? false) === value) return pinned;
  const next = new Set(current);
  if (value) next.add(tabId);
  else next.delete(tabId);
  return withWorkspacePins(pinned, workspaceKey, next);
}

/** Moves a pin to the tab that replaced `fromTabId` (a draft that became its agent, a merge). */
export function carryTabPin(
  pinned: PinnedTabIdsByWorkspace,
  workspaceKey: string,
  fromTabId: string,
  toTabId: string,
): PinnedTabIdsByWorkspace {
  if (fromTabId === toTabId || !isTabPinned(pinned, workspaceKey, fromTabId)) return pinned;
  return withTabPinned(
    withTabPinned(pinned, workspaceKey, fromTabId, false),
    workspaceKey,
    toTabId,
    true,
  );
}

export function withWorkspacePins(
  pinned: PinnedTabIdsByWorkspace,
  workspaceKey: string,
  tabIds: ReadonlySet<string>,
): PinnedTabIdsByWorkspace {
  if (tabIds.size === 0) {
    if (!(workspaceKey in pinned)) return pinned;
    const { [workspaceKey]: _removed, ...rest } = pinned;
    return rest;
  }
  return { ...pinned, [workspaceKey]: tabIds };
}

export function paneHoldsPinnedTab(
  pinnedTabIds: ReadonlySet<string> | undefined,
  pane: { tabIds: readonly string[] } | null | undefined,
): boolean {
  return Boolean(pinnedTabIds && pane?.tabIds.some((tabId) => pinnedTabIds.has(tabId)));
}

/** Duplicate tabs of one entity merge into the keeper; a pin on any of them moves to it. */
export function movePinsToKeeper(
  pinnedTabIds: Set<string>,
  duplicates: readonly { tabId: string }[],
  keeperTabId: string,
): void {
  if (!duplicates.some((tab) => pinnedTabIds.has(tab.tabId))) return;
  for (const tab of duplicates) pinnedTabIds.delete(tab.tabId);
  pinnedTabIds.add(keeperTabId);
}

/** Drops pins whose tab no longer exists in the layout, so the set never outlives its tabs. */
export function prunePinnedTabIds(
  pinnedTabIds: ReadonlySet<string> | undefined,
  root: SplitNode,
): ReadonlySet<string> {
  if (!pinnedTabIds || pinnedTabIds.size === 0) return pinnedTabIds ?? new Set();
  const present = new Set(collectTabIds(root));
  const kept = [...pinnedTabIds].filter((tabId) => present.has(tabId));
  return kept.length === pinnedTabIds.size ? pinnedTabIds : new Set(kept);
}

function collectTabIds(node: SplitNode): string[] {
  if (node.kind === "pane") return node.pane.tabIds;
  return node.group.children.flatMap(collectTabIds);
}
