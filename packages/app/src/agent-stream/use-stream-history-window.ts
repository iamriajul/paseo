import { useCallback, useEffect, useMemo, useState } from "react";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import { findMountedWindowStart, getMountedRecentStreamItems } from "./history-window";

// Callers reveal a message, not a row: an assistant message is several block rows and
// the window has to open at the first of them.
function findMessageRowIndex(items: StreamItem[], messageId: string): number {
  return items.findIndex((item) => getStreamItemMessageId(item) === messageId);
}

function findEarlierHistoryWindowStart(input: {
  items: StreamItem[];
  start: number;
  itemId: string | undefined;
}): number {
  const targetIndex = input.itemId ? findMessageRowIndex(input.items, input.itemId) : -1;
  const targetStart = targetIndex >= 0 && targetIndex < input.start ? targetIndex : input.start;
  if (!input.itemId) {
    return findMountedWindowStart({
      items: input.items.slice(0, targetStart),
      minMountedCount: getMountedRecentStreamItems(),
    });
  }
  return findMountedWindowStart({
    items: input.items.slice(0, targetStart + 1),
    minMountedCount: 1,
  });
}

interface HistoryWindowBoundary {
  agentId: string;
  boundaryItemId: string | null;
  initialized: boolean;
}

// Looks the boundary up in `current`, not in the window this render saw: the stream list
// reveals history from its own effect, which runs first, so `current` can already be newer.
function reconcileHistoryWindow(input: {
  current: HistoryWindowBoundary;
  agentId: string;
  items: StreamItem[];
  initialBoundaryItemId: string | null;
}): HistoryWindowBoundary {
  const { current, agentId, items, initialBoundaryItemId } = input;
  const hasItems = items.length > 0;
  if (current.agentId !== agentId) {
    return { agentId, boundaryItemId: initialBoundaryItemId, initialized: hasItems };
  }
  if (!current.initialized && hasItems) {
    return { ...current, boundaryItemId: initialBoundaryItemId, initialized: true };
  }
  const boundaryItemId = current.boundaryItemId;
  if (boundaryItemId !== null && !items.some((item) => item.id === boundaryItemId)) {
    return { ...current, boundaryItemId: initialBoundaryItemId };
  }
  return current;
}

export function useStreamHistoryWindow(input: {
  agentId: string;
  items: StreamItem[];
  loadRemoteOlder: () => boolean | Promise<boolean>;
}) {
  const { agentId, items, loadRemoteOlder } = input;
  const initialStart = useMemo(
    () => findMountedWindowStart({ items, minMountedCount: getMountedRecentStreamItems() }),
    [items],
  );
  const initialBoundaryItemId = initialStart === 0 ? null : (items[initialStart]?.id ?? null);
  const [window, setWindow] = useState(() => ({
    agentId,
    boundaryItemId: initialBoundaryItemId,
    initialized: items.length > 0,
  }));
  const boundaryItemId = window.agentId === agentId ? window.boundaryItemId : null;
  const boundaryIndex = useMemo(
    () => (boundaryItemId === null ? -1 : items.findIndex((item) => item.id === boundaryItemId)),
    [boundaryItemId, items],
  );
  let start = initialStart;
  if (window.agentId === agentId && window.initialized) {
    if (window.boundaryItemId === null) {
      start = 0;
    } else if (boundaryIndex >= 0) {
      start = boundaryIndex;
    }
  }

  useEffect(() => {
    setWindow((current) =>
      reconcileHistoryWindow({ current, agentId, items, initialBoundaryItemId }),
    );
  }, [agentId, initialBoundaryItemId, items]);

  const revealLoadedHistory = useCallback(
    (itemId?: string): boolean => {
      const targetIndex = itemId ? findMessageRowIndex(items, itemId) : -1;
      if (start === 0 || (itemId !== undefined && (targetIndex < 0 || targetIndex >= start))) {
        return false;
      }
      const nextStart = findEarlierHistoryWindowStart({ items, start, itemId });
      if (nextStart === start) {
        return false;
      }
      setWindow({
        agentId,
        boundaryItemId: items[nextStart]?.id ?? null,
        initialized: true,
      });
      return true;
    },
    [agentId, items, start],
  );
  const loadOlder = useCallback(async (): Promise<boolean> => {
    return revealLoadedHistory() || (await loadRemoteOlder());
  }, [loadRemoteOlder, revealLoadedHistory]);

  return { start, hasLocalHistory: start > 0, revealLoadedHistory, loadOlder };
}
