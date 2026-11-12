// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCopyShortcut, useViewerShortcuts, viewerShortcutOf } from "./viewer-shortcuts";

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

interface FakeDesktop {
  focus: Array<{ token: string; focused: boolean }>;
  emit: (event: string) => void;
}

/** Electron's preload bridge: the focus report, and the event channel main's menu sends on. */
function installDesktop(): FakeDesktop {
  const handlers = new Map<string, (payload: unknown) => void>();
  const focus: FakeDesktop["focus"] = [];
  Object.assign(window, {
    paseoDesktop: {
      browser: {
        setServerTabFocus: (input: { token: string; focused: boolean }) => focus.push(input),
      },
      events: {
        on: async (event: string, handler: (payload: unknown) => void) => {
          handlers.set(event, handler);
          return () => handlers.delete(event);
        },
      },
    },
  });
  return { focus, emit: (event) => handlers.get(event)?.({}) };
}

// Reloads within a short window count once, across instances; each test starts well past
// the previous test's last reload.
let clock = Date.parse("2026-01-01T00:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 60_000;
  vi.setSystemTime(clock);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete (window as { paseoDesktop?: unknown }).paseoDesktop;
});

describe("server browser viewer shortcuts", () => {
  it("reloads the tab on Cmd/Ctrl+R and focuses the URL on Cmd/Ctrl+L in Electron, keeping both from the page", () => {
    installDesktop();
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

  it("leaves a plain browser's own reload and address bar alone", () => {
    const onReload = vi.fn();
    renderHook(() => useViewerShortcuts({ enabled: true, onReload, onFocusUrl: vi.fn() }));
    expect(press({ key: "r", code: "KeyR", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press({ key: "l", code: "KeyL", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("tells Electron main the pane is focused, and reloads the tab when the Reload menu item fires", async () => {
    const desktop = installDesktop();
    const onReload = vi.fn();
    const { unmount } = renderHook(() =>
      useViewerShortcuts({ enabled: true, onReload, onFocusUrl: vi.fn() }),
    );
    await Promise.resolve();
    expect(desktop.focus).toEqual([{ token: expect.any(String), focused: true }]);

    desktop.emit("server-browser-reload");
    expect(onReload).toHaveBeenCalledTimes(1);

    unmount();
    expect(desktop.focus.at(-1)).toEqual({ token: desktop.focus[0]!.token, focused: false });
  });

  it("reloads once when the keydown and the menu both see one press", async () => {
    const desktop = installDesktop();
    const onReload = vi.fn();
    renderHook(() => useViewerShortcuts({ enabled: true, onReload, onFocusUrl: vi.fn() }));
    await Promise.resolve();
    press({ key: "r", code: "KeyR", ctrlKey: true });
    desktop.emit("server-browser-reload");
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("leaves the keys alone while another pane is focused", () => {
    installDesktop();
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
