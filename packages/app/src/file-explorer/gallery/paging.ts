/**
 * When a one-finger drag over the gallery pages, and where it lands. These run in the native
 * pager's gesture worklets, so each one is a worklet; vitest calls them as plain functions.
 */

/** A drag past this share of the width pages. */
export const PAGE_DISTANCE = 0.2;
/** A flick faster than this (px/s) pages however short it is. */
export const PAGE_VELOCITY = 500;
/** Past the first or last image the strip follows the finger at this rate. */
export const EDGE_RESISTANCE = 0.3;

/** A zoomed-in image takes the drag to pan; a fitted one leaves it to the pager. */
export function canSwipePage(input: { zoomed: boolean; count: number; width: number }): boolean {
  "worklet";
  return !input.zoomed && input.count > 1 && input.width > 0;
}

/** Where the strip sits while the finger is down. */
export function dragOffset(input: {
  index: number;
  count: number;
  width: number;
  translationX: number;
}): number {
  "worklet";
  const { index, count, width, translationX } = input;
  const pastEnd = (translationX > 0 && index === 0) || (translationX < 0 && index === count - 1);
  return -index * width + (pastEnd ? translationX * EDGE_RESISTANCE : translationX);
}

/** The image a released drag lands on: one step either way, never past either end. */
export function settleSwipe(input: {
  index: number;
  count: number;
  width: number;
  translationX: number;
  velocityX: number;
}): number {
  "worklet";
  const { index, count, width, translationX, velocityX } = input;
  const forward = translationX < -width * PAGE_DISTANCE || velocityX < -PAGE_VELOCITY;
  const back = translationX > width * PAGE_DISTANCE || velocityX > PAGE_VELOCITY;
  // A flick against the drag direction stays: the finger said both.
  if (forward && !back && index < count - 1) return index + 1;
  if (back && !forward && index > 0) return index - 1;
  return index;
}
