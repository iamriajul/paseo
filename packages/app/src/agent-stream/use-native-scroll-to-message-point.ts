import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { FlatList } from "react-native";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import { useStableEvent } from "@/hooks/use-stable-event";
import { resolveScrollToPointParams, type MessageScrollPoint } from "./native-scroll-point";

interface Input {
  listRef: RefObject<FlatList<StreamItem> | null>;
  getRows(): StreamItem[];
  getMetrics(): { viewportHeight: number; contentHeight: number; offsetY: number };
  /** Called before each scroll so the list stops following new output. */
  onBeforeScroll(): void;
  scrollToNewest(): void;
}

/** Later passes re-aim once the rows between here and the target have been measured. */
const SETTLE_DELAYS_MS = [0, 120, 400];
const FAILED_INDEX_RETRY_MS = 80;
const MAX_FAILED_INDEX_RETRIES = 8;

/**
 * Scrolls the native inverted list to a point inside a message row, for chat find.
 * A row the list has not rendered has no known position: the list reports the index as
 * failed, this jumps to its estimated offset so the row renders, and tries again.
 */
export function useNativeScrollToMessagePoint(input: Input) {
  const rowHeights = useRef(new Map<string, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const failedRetries = useRef(0);
  const pending = useRef<{ messageId: string; point: MessageScrollPoint } | null>(null);

  const cancel = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
    pending.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const later = useCallback((run: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, delay);
    timers.current.add(timer);
  }, []);

  const clampToOldestEdge = useStableEvent(() => {
    // iOS applies an offset past the content's end as written and leaves a gap there.
    const metrics = input.getMetrics();
    const maxOffset = Math.max(0, metrics.contentHeight - metrics.viewportHeight);
    if (metrics.contentHeight > 0 && metrics.offsetY > maxOffset) {
      input.listRef.current?.scrollToOffset({ offset: maxOffset, animated: false });
    }
  });

  const attempt = useStableEvent(() => {
    const request = pending.current;
    const list = input.listRef.current;
    if (!request || !list) return;
    const rows = input.getRows();
    const index = rows.findIndex((row) => getStreamItemMessageId(row) === request.messageId);
    input.onBeforeScroll();
    if (index < 0) {
      // The live turn renders in the list's header, at the newest edge.
      input.scrollToNewest();
      return;
    }
    const row = rows[index]!;
    list.scrollToIndex({
      index,
      animated: false,
      ...resolveScrollToPointParams({
        point: request.point,
        viewportHeight: input.getMetrics().viewportHeight,
        rowHeight: rowHeights.current.get(row.id),
      }),
    });
    later(clampToOldestEdge, 32);
  });

  const scrollToMessagePoint = useCallback(
    (messageId: string, point: MessageScrollPoint) => {
      cancel();
      pending.current = { messageId, point };
      failedRetries.current = 0;
      for (const delay of SETTLE_DELAYS_MS) later(attempt, delay);
    },
    [attempt, cancel, later],
  );

  const onScrollToIndexFailed = useStableEvent(
    (info: { index: number; averageItemLength: number }) => {
      if (!pending.current || failedRetries.current >= MAX_FAILED_INDEX_RETRIES) return;
      failedRetries.current += 1;
      input.listRef.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: false,
      });
      later(attempt, FAILED_INDEX_RETRY_MS);
    },
  );

  const setRowHeight = useCallback((rowId: string, height: number) => {
    rowHeights.current.set(rowId, height);
  }, []);

  return { scrollToMessagePoint, onScrollToIndexFailed, cancel, setRowHeight };
}
