// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isCopyShortcut, useViewerShortcuts, viewerShortcutOf } from "./viewer-shortcuts";

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

describe("server browser viewer shortcuts", () => {
  it("reloads the tab on Cmd/Ctrl+R and focuses the URL on Cmd/Ctrl+L, keeping both from the page and the app", () => {
    const onReload = vi.fn();
    const onFocusUrl = vi.fn();
    const pageKeys = vi.fn();
    document.body.addEventListener("keydown", pageKeys);
    const { unmount } = renderHook(() =>
      useViewerShortcuts({ enabled: true, onReload, onFocusUrl }),
    );

    const reload = press({ key: "r", code: "KeyR", ctrlKey: true });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(reload.defaultPrevented).toBe(true);
    const focus = press({ key: "l", code: "KeyL", metaKey: true });
    expect(onFocusUrl).toHaveBeenCalledTimes(1);
    expect(focus.defaultPrevented).toBe(true);
    expect(pageKeys).not.toHaveBeenCalled();

    // Plain keys and other shortcuts still reach the page.
    press({ key: "r", code: "KeyR" });
    press({ key: "r", code: "KeyR", ctrlKey: true, shiftKey: true });
    expect(pageKeys).toHaveBeenCalledTimes(2);
    unmount();
    document.body.removeEventListener("keydown", pageKeys);
  });

  it("leaves the keys alone while another pane is focused", () => {
    const onReload = vi.fn();
    renderHook(() => useViewerShortcuts({ enabled: false, onReload, onFocusUrl: vi.fn() }));
    expect(press({ key: "r", code: "KeyR", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("recognises the copy and toolbar shortcuts", () => {
    expect(isCopyShortcut({ key: "c", ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isCopyShortcut({ key: "X", ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isCopyShortcut({ key: "c", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(
      viewerShortcutOf({
        key: "й",
        code: "KeyR",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("reload");
  });
});
