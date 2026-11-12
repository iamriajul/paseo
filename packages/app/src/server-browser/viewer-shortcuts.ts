import { useEffect, useRef } from "react";
import { isWeb } from "@/constants/platform";

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

/**
 * While the server tab's pane is the focused one, Cmd/Ctrl+L and Cmd/Ctrl+R act on the tab, as in
 * the desktop Browser. Handled in the capture phase, so the page never gets them, and marked
 * handled, so Electron's Reload menu item (which reloads the app window when no webview is active)
 * and a browser's own reload stay out of it.
 */
export function useViewerShortcuts(input: {
  enabled: boolean;
  onFocusUrl: () => void;
  onReload: () => void;
}): void {
  const handlersRef = useRef(input);
  handlersRef.current = input;
  useEffect(() => {
    if (!isWeb || !input.enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = viewerShortcutOf(event);
      if (!shortcut) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (shortcut === "focus-url") handlersRef.current.onFocusUrl();
      else handlersRef.current.onReload();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [input.enabled]);
}
