import { describe, expect, it } from "vitest";
import { resolveScrollToPointParams, scrollOffsetForParams } from "./native-scroll-point";

/** Distance from the viewport's top to the point, for a row at `rowOffset` from the bottom. */
function pointTop(input: {
  rowOffset: number;
  rowHeight: number;
  viewportHeight: number;
  fraction: number;
  offset: number;
}): number {
  const pointFromBottom = input.rowOffset + (1 - input.fraction) * input.rowHeight;
  return input.viewportHeight - (pointFromBottom - input.offset);
}

describe("resolveScrollToPointParams", () => {
  const viewportHeight = 600;
  const point = { fraction: 0, topClearance: 56 };

  it("puts the top of a measured row right under the overlay", () => {
    const row = { rowOffset: 4000, rowHeight: 120 };
    const params = resolveScrollToPointParams({ point, viewportHeight, rowHeight: row.rowHeight });
    const offset = scrollOffsetForParams({ ...row, viewportHeight, ...params });
    expect(pointTop({ ...row, viewportHeight, fraction: 0, offset })).toBeCloseTo(80);
  });

  it("lands on the same place before the row has been measured", () => {
    const row = { rowOffset: 4000, rowHeight: 120 };
    const params = resolveScrollToPointParams({ point, viewportHeight, rowHeight: undefined });
    const offset = scrollOffsetForParams({ ...row, viewportHeight, ...params });
    expect(pointTop({ ...row, viewportHeight, fraction: 0, offset })).toBeCloseTo(80);
  });

  it("shows a point deep in a row taller than the viewport, lower than a top point", () => {
    const row = { rowOffset: 2000, rowHeight: 3000 };
    const deep = { fraction: 0.5, topClearance: 56 };
    const params = resolveScrollToPointParams({
      point: deep,
      viewportHeight,
      rowHeight: row.rowHeight,
    });
    const offset = scrollOffsetForParams({ ...row, viewportHeight, ...params });
    const top = pointTop({ ...row, viewportHeight, fraction: 0.5, offset });
    expect(top).toBeGreaterThan(80);
    expect(top).toBeLessThan(viewportHeight / 2);
  });

  it("stays at the newest edge for a short newest row instead of scrolling it away", () => {
    const row = { rowOffset: 0, rowHeight: 60 };
    const params = resolveScrollToPointParams({ point, viewportHeight, rowHeight: row.rowHeight });
    expect(scrollOffsetForParams({ ...row, viewportHeight, ...params })).toBe(0);
  });

  it("survives a row exactly as tall as the viewport", () => {
    const params = resolveScrollToPointParams({ point, viewportHeight, rowHeight: 600 });
    expect(Number.isFinite(params.viewPosition)).toBe(true);
    expect(Number.isFinite(params.viewOffset)).toBe(true);
  });
});
