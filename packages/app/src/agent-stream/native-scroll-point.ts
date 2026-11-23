/** A point inside a message row: `fraction` is how far down the row it sits, 0 at the row's top. */
export interface MessageScrollPoint {
  fraction: number;
  /** Height at the top of the viewport that something covers (the header, the find bar). */
  topClearance: number;
}

const POINT_MARGIN = 24;
/** How far into the free viewport a point deep in a tall row lands. */
const DEEP_POINT_SHARE = 0.3;

/**
 * `FlatList.scrollToIndex` parameters that put a point of a row below the top overlay of
 * an inverted list. The list scrolls to `rowOffset - viewPosition * (viewport - row) -
 * viewOffset`, measured from the visual bottom, so the row's top is its far edge.
 *
 * A point at the top of a row lands right under the overlay. The fraction is an estimate
 * from the message's text, so a point further down a tall row lands lower in the viewport,
 * where an estimate that is off in either direction still shows it.
 *
 * With the row's height known, everything goes into `viewPosition`: the list clamps that
 * term at the newest end, and a `viewOffset` would be applied after the clamp.
 */
export function resolveScrollToPointParams(input: {
  point: MessageScrollPoint;
  viewportHeight: number;
  rowHeight: number | undefined;
}): { viewPosition: number; viewOffset: number } {
  const fraction = Math.min(1, Math.max(0, input.point.fraction));
  const viewport = Math.max(0, input.viewportHeight);
  const free = Math.max(0, viewport - input.point.topClearance - POINT_MARGIN);
  const anchor = input.point.topClearance + POINT_MARGIN + fraction * DEEP_POINT_SHARE * free;
  const row = input.rowHeight;
  if (row !== undefined && Math.abs(viewport - row) > 1) {
    return {
      viewPosition: (viewport - anchor - (1 - fraction) * row) / (viewport - row),
      viewOffset: 0,
    };
  }
  return { viewPosition: 1 - fraction, viewOffset: fraction * viewport - anchor };
}

/** The offset `scrollToIndex` produces for those parameters, before the platform clamps it. */
export function scrollOffsetForParams(input: {
  rowOffset: number;
  rowHeight: number;
  viewportHeight: number;
  viewPosition: number;
  viewOffset: number;
}): number {
  return (
    Math.max(0, input.rowOffset - input.viewPosition * (input.viewportHeight - input.rowHeight)) -
    input.viewOffset
  );
}
