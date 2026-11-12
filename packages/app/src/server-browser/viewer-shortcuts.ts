import { useEffect, useRef } from "react";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";

type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

/** Cmd/Ctrl+C or Cmd/Ctrl+X, the shortcuts that copy a selection. */
export function isCopyShortcut(event: Omit<ShortcutKeyEvent, "code" | "shiftKey">): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && /^[cx]$/i.test(event.key);
}

/** The desktop Browser's toolbar shortcuts: Cmd/Ctrl+L focuses the URL, Cmd/Ctrl+R reloads. */
export function viewerShortcutOf(event: ShortcutKeyEvent): "focus-url" | "reload" | null {
  if (event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (key === "l" || event.code === "KeyL") return "focus-url";
  if (key === "r" || event.code === "KeyR") return "reload";
  return null;
}

/** Both reload paths (the keydown and Electron's menu) can see one press; it reloads once. */
const RELOAD_DEDUPE_MS = 400;
const SERVER_BROWSER_RELOAD_EVENT = "server-browser-reload";
let nextFocusToken = 1;
// Module-wide: the press and the menu's reload can reach two instances of the hook when the
// pane's focus changes in between, and the window has one keyboard.
let lastReloadAt = Number.NEGATIVE_INFINITY;

/**
 * Electron only, as in the desktop Browser pane, so a plain browser keeps its own reload and
 * address bar: while the server tab's pane is the focused one, Cmd/Ctrl+L focuses the URL and
 * Cmd/Ctrl+R reloads the tab. The keydown is handled in the capture phase, so the page never gets
 * it. Electron's Reload menu item can also take Cmd/Ctrl+R before the page sees it (macOS key
 * equivalents), so the pane tells main it is focused, and main sends that Reload here instead of
 * reloading the app window (`features/server-browser-focus.ts`).
 */
export function useViewerShortcuts(input: {
  enabled: boolean;
  onFocusUrl: () => void;
  onReload: () => void;
}): void {
  const handlersRef = useRef(input);
  handlersRef.current = input;
  const enabled = input.enabled && isElectronRuntime();
  useEffect(() => {
    if (!enabled) return undefined;
    const bridge = getDesktopHost()?.browser;
    const token = `server-tab-${nextFocusToken++}`;
    const reload = () => {
      const now = Date.now();
      if (now - lastReloadAt < RELOAD_DEDUPE_MS) return;
      lastReloadAt = now;
      handlersRef.current.onReload();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = viewerShortcutOf(event);
      if (!shortcut) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (shortcut === "focus-url") handlersRef.current.onFocusUrl();
      else reload();
    };
    window.addEventListener("keydown", onKeyDown, true);
    bridge?.setServerTabFocus?.({ token, focused: true });
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenToDesktopEvent(SERVER_BROWSER_RELOAD_EVENT, reload)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown, true);
      bridge?.setServerTabFocus?.({ token, focused: false });
      unlisten?.();
    };
  }, [enabled]);
}
