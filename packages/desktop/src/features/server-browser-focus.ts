/**
 * Which app windows have a server browser tab's pane focused. A server tab has no webview here,
 * so the Reload menu item cannot find it the way it finds a Browser webview; the renderer reports
 * the focused pane instead, and Reload goes to that tab rather than reloading the whole window.
 */
const focusedByHost = new Map<number, string>();

/** `token` names one pane, so a pane losing focus never clears the one that just gained it. */
export function setServerBrowserFocus(input: {
  hostWebContentsId: number;
  token: string;
  focused: boolean;
}): void {
  if (input.focused) {
    focusedByHost.set(input.hostWebContentsId, input.token);
  } else if (focusedByHost.get(input.hostWebContentsId) === input.token) {
    focusedByHost.delete(input.hostWebContentsId);
  }
}

export function hasFocusedServerBrowser(hostWebContentsId: number): boolean {
  return focusedByHost.has(hostWebContentsId);
}

export function forgetServerBrowserFocus(hostWebContentsId: number): void {
  focusedByHost.delete(hostWebContentsId);
}

export const SERVER_BROWSER_RELOAD_EVENT = "server-browser-reload";
