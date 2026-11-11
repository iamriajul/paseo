import { describe, expect, it } from "vitest";
import { canSwipePage, dragOffset, settleSwipe } from "./paging";

const width = 400;

describe("canSwipePage", () => {
  it("pages a fitted image and leaves a zoomed-in one to pan", () => {
    expect(canSwipePage({ zoomed: false, count: 5, width })).toBe(true);
    expect(canSwipePage({ zoomed: true, count: 5, width })).toBe(false);
  });

  it("does not page a lone image or before the pager has a width", () => {
    expect(canSwipePage({ zoomed: false, count: 1, width })).toBe(false);
    expect(canSwipePage({ zoomed: false, count: 5, width: 0 })).toBe(false);
  });
});

describe("settleSwipe", () => {
  const swipe = (index: number, translationX: number, velocityX = 0) =>
    settleSwipe({ index, count: 5, width, translationX, velocityX });

  it("pages past a fifth of the width, and stays short of it", () => {
    expect(swipe(2, -81)).toBe(3);
    expect(swipe(2, 81)).toBe(1);
    expect(swipe(2, -79)).toBe(2);
    expect(swipe(2, 79)).toBe(2);
  });

  it("pages a short flick", () => {
    expect(swipe(2, -20, -900)).toBe(3);
    expect(swipe(2, 20, 900)).toBe(1);
  });

  it("stays when the flick goes against the drag", () => {
    expect(swipe(2, -200, 900)).toBe(2);
  });

  it("stops at the first and last image", () => {
    expect(swipe(0, 300, 2000)).toBe(0);
    expect(swipe(4, -300, -2000)).toBe(4);
    expect(swipe(0, -300)).toBe(1);
    expect(swipe(4, 300)).toBe(3);
  });
});

describe("dragOffset", () => {
  const drag = (index: number, translationX: number) =>
    dragOffset({ index, count: 5, width, translationX });

  it("follows the finger between images", () => {
    expect(drag(2, -100)).toBe(-900);
    expect(drag(2, 100)).toBe(-700);
  });

  it("resists past the first and last image", () => {
    expect(drag(0, 100)).toBe(30);
    expect(drag(4, -100)).toBe(-1630);
    expect(drag(0, -100)).toBe(-100);
  });
});
