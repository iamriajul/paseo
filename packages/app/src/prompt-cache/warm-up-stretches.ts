import { isCacheWarmPrompt, isCacheWarmReply } from "@getpaseo/protocol/agent-cache-warm";
import type { StreamItem } from "@/types/stream";

/** The warm-ups of one idle stretch, shown as one line under the row they followed. */
export interface WarmUpStretch {
  count: number;
  firstAt: number;
  lastAt: number;
}

export type WarmUpStretches = ReadonlyMap<string, WarmUpStretch>;

export const NO_WARM_UP_STRETCHES: WarmUpStretches = new Map();

/** A warm-up sent as a turn, from before warm-ups went through a fork; it renders nothing. */
export function isWarmPingRow(item: StreamItem, above: StreamItem | null): boolean {
  if (item.kind === "user_message") return isCacheWarmPrompt(item.text);
  return (
    item.kind === "assistant_message" &&
    isCacheWarmReply(item.text) &&
    above?.kind === "user_message" &&
    isCacheWarmPrompt(above.text)
  );
}

/**
 * A turn footer hosted on a warm-up turn's rows. Those rows render nothing, so the footer would
 * be a "Worked for 4s" under no turn at all. The host's neighbours are read both ways because a
 * native list holds its rows newest first.
 */
export function isWarmPingTurnHost(host: {
  items: readonly StreamItem[];
  startIndex: number;
}): boolean {
  const item = host.items[host.startIndex];
  if (!item) return false;
  const before = host.items[host.startIndex - 1] ?? null;
  const after = host.items[host.startIndex + 1] ?? null;
  return isWarmPingRow(item, before) || isWarmPingRow(item, after);
}

interface Bucket {
  recorded: number[];
  pingRows: number[];
}

/**
 * Folds warm-ups into the visible row each one followed. Rows may come in any order (a native
 * list renders newest first); they are read by time. A fork warm-up leaves no row of its
 * own, so its time places it; a warm-up sent as a turn is also its own pair of rows, so both
 * sources are kept and the larger count wins rather than adding the same warm-up twice.
 * Warm-ups before the first loaded row, or after the last when newer rows are not loaded,
 * belong to rows not on screen and are left out.
 */
export function foldWarmUpStretches(input: {
  rows: readonly StreamItem[];
  /** Times of recorded warm-ups, in ms, ascending. */
  warmUpTimes: readonly number[];
  hasNewerRows: boolean;
}): WarmUpStretches {
  const { warmUpTimes, hasNewerRows } = input;
  // Hermes has no Array.prototype.toSorted: calling it crashed the agent view on Android.
  const rows = [...input.rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const anchors: { id: string; at: number }[] = [];
  const buckets = new Map<string, Bucket>();
  const bucketFor = (id: string): Bucket => {
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { recorded: [], pingRows: [] };
      buckets.set(id, bucket);
    }
    return bucket;
  };

  let above: StreamItem | null = null;
  for (const row of rows) {
    if (isWarmPingRow(row, above)) {
      const anchor = anchors.at(-1);
      if (anchor && row.kind === "user_message") {
        bucketFor(anchor.id).pingRows.push(row.timestamp.getTime());
      }
    } else {
      anchors.push({ id: row.id, at: row.timestamp.getTime() });
    }
    above = row;
  }

  let next = 0;
  for (const at of warmUpTimes) {
    while (next < anchors.length && anchors[next]!.at <= at) next += 1;
    if (next === 0) continue;
    if (next === anchors.length && hasNewerRows) continue;
    bucketFor(anchors[next - 1]!.id).recorded.push(at);
  }

  if (buckets.size === 0) return NO_WARM_UP_STRETCHES;
  const stretches = new Map<string, WarmUpStretch>();
  for (const [id, { recorded, pingRows }] of buckets) {
    const times = [...recorded, ...pingRows];
    stretches.set(id, {
      count: Math.max(recorded.length, pingRows.length),
      firstAt: Math.min(...times),
      lastAt: Math.max(...times),
    });
  }
  return stretches;
}

export function sameWarmUpStretches(a: WarmUpStretches, b: WarmUpStretches): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, stretch] of a) {
    const other = b.get(id);
    if (
      !other ||
      other.count !== stretch.count ||
      other.firstAt !== stretch.firstAt ||
      other.lastAt !== stretch.lastAt
    ) {
      return false;
    }
  }
  return true;
}
