import type { StreamItem } from "@/types/stream";
import { isWarmPingRow } from "@/prompt-cache/warm-up-stretches";
import { continuesTurn } from "./turn-membership";

export const DEFAULT_MOUNTED_RECENT_STREAM_ITEMS = 20;

type MountedRecentStreamItemsE2ETestGlobals = typeof globalThis & {
  __PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS?: unknown;
};

function readPositiveIntegerOverride(value: unknown): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value as number);
  return normalized > 0 ? normalized : null;
}

export function getMountedRecentStreamItems(): number {
  const override = readPositiveIntegerOverride(
    (globalThis as MountedRecentStreamItemsE2ETestGlobals)
      .__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS,
  );
  return override ?? DEFAULT_MOUNTED_RECENT_STREAM_ITEMS;
}

/**
 * Whether a row draws anything. A warm-up sent as a turn is a prompt and an "ok" that render
 * nothing, so a window counted in items can open on ten warm-ups and show an empty chat.
 */
export function rendersStreamRow(item: StreamItem, above: StreamItem | null): boolean {
  return !isWarmPingRow(item, above);
}

export function findMountedWindowStart(input: {
  items: StreamItem[];
  minMountedCount: number;
  /** Counts only these rows towards `minMountedCount`; every row counts when omitted. */
  countsRow?: (item: StreamItem, above: StreamItem | null) => boolean;
}): number {
  const { items, minMountedCount, countsRow } = input;
  let startIndex = items.length;
  let counted = 0;
  while (startIndex > 0 && counted < minMountedCount) {
    startIndex -= 1;
    if (!countsRow || countsRow(items[startIndex]!, items[startIndex - 1] ?? null)) {
      counted += 1;
    }
  }
  while (startIndex > 0 && continuesTurn(items[startIndex - 1], items[startIndex])) {
    startIndex -= 1;
  }
  return startIndex;
}

/** How many rows of `items` draw anything, up to `limit`. */
export function countRenderedStreamRows(items: StreamItem[], limit: number): number {
  let count = 0;
  for (let index = items.length - 1; index >= 0 && count < limit; index -= 1) {
    if (rendersStreamRow(items[index]!, items[index - 1] ?? null)) count += 1;
  }
  return count;
}
