import { BrowserTabClosedError, PageNavigatedError } from "./service.js";

/**
 * The guest WebContents surface page scripts and navigation need. Electron's
 * `webContents.executeJavaScript` does not run a script while the main frame is loading:
 * it waits for `did-stop-loading`, so one image that never finishes stalls every snapshot,
 * evaluate and wait on the tab. `mainFrame.executeJavaScript` runs on the current document
 * at once. CDP `Runtime.evaluate` is no substitute: it waits for a pending navigation to commit.
 */
export interface PageLifecycleContents {
  readonly mainFrame: { executeJavaScript(code: string): Promise<unknown> };
  isDestroyed(): boolean;
  isLoadingMainFrame(): boolean;
  loadURL(url: string): Promise<void>;
  on(event: "did-navigate", listener: (event: unknown, url: string) => void): unknown;
  on(event: "dom-ready" | "destroyed" | "render-process-gone", listener: () => void): unknown;
  removeListener(event: "did-navigate", listener: (event: unknown, url: string) => void): unknown;
  removeListener(
    event: "dom-ready" | "destroyed" | "render-process-gone",
    listener: () => void,
  ): unknown;
}

class PageRendererGoneError extends Error {
  public constructor() {
    super("The page's renderer process exited while the script was running.");
    this.name = "PageRendererGoneError";
  }
}

/**
 * Runs a script in the page's main world on the document showing now. A script still awaiting
 * when the page commits a new document never settles in Electron, so the commit rejects it.
 */
export function runPageScript(contents: PageLifecycleContents, code: string): Promise<unknown> {
  if (contents.isDestroyed()) {
    return Promise.reject(new BrowserTabClosedError());
  }
  return new Promise((resolve, reject) => {
    const onNavigate = (_event: unknown, url: string) => {
      cleanup();
      reject(new PageNavigatedError(url));
    };
    const onDestroyed = () => {
      cleanup();
      reject(new BrowserTabClosedError());
    };
    const onRendererGone = () => {
      cleanup();
      reject(new PageRendererGoneError());
    };
    const cleanup = () => {
      contents.removeListener("did-navigate", onNavigate);
      contents.removeListener("destroyed", onDestroyed);
      contents.removeListener("render-process-gone", onRendererGone);
    };
    contents.on("did-navigate", onNavigate);
    contents.on("destroyed", onDestroyed);
    contents.on("render-process-gone", onRendererGone);
    let frame: PageLifecycleContents["mainFrame"];
    try {
      frame = contents.mainFrame;
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    frame.executeJavaScript(code).finally(cleanup).then(resolve, reject);
  });
}

/**
 * Loads a URL and settles once the new document's DOM is ready, not when every subresource has
 * finished: `loadURL` alone waits for the load event, which a hanging image or socket delays
 * past any budget. A navigation the page replaces (a script redirect) rejects `loadURL` with
 * ERR_ABORTED; that is not a failure, and the replacement's DOM-ready settles the load.
 */
export function loadDocument(contents: PageLifecycleContents, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let committed = false;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      contents.removeListener("did-navigate", onNavigate);
      contents.removeListener("dom-ready", onDomReady);
      contents.removeListener("destroyed", onDestroyed);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onNavigate = () => {
      committed = true;
    };
    const onDomReady = () => {
      if (committed) finish();
    };
    const onDestroyed = () => finish(new BrowserTabClosedError());
    contents.on("did-navigate", onNavigate);
    contents.on("dom-ready", onDomReady);
    contents.on("destroyed", onDestroyed);
    contents.loadURL(url).then(
      () => finish(),
      (error: unknown) => {
        if (!isNavigationAbort(error)) {
          finish(error);
          return;
        }
        // Replaced by a newer navigation that is still loading: its DOM-ready settles this.
        if (!contents.isLoadingMainFrame()) finish();
      },
    );
  });
}

function isNavigationAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  return (
    record.code === "ERR_ABORTED" ||
    (typeof record.message === "string" && record.message.includes("ERR_ABORTED (-3)"))
  );
}
