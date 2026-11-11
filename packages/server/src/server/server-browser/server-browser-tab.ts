import type { BrowserAutomationConsoleLogEntry } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type {
  ServerBrowserConsoleEntry,
  ServerBrowserInputEvent,
  ServerBrowserTab as ServerBrowserTabInfo,
} from "@getpaseo/protocol/server-browser/rpc-schemas";
import type { CdpConnection, CdpEvent, CdpParams } from "./cdp-connection.js";
import { CdpSessionQueue } from "./engine/cdp-session-queue.js";
import type { TabContents, TabImage } from "./engine/service.js";
import type { IsolatedKeyboardInputEvent } from "./engine/trusted-input.js";
import { ScreencastHub, type ScreencastSize } from "./screencast-hub.js";
import { cancelPick } from "./element-picker.js";
import { cdpKeyEventsForElectronKey } from "./key-events.js";
import type { LocalStorageItems } from "./workspace-storage-state.js";
import {
  stripWindowTitle,
  TITLE_BINDING,
  TITLE_WORLD,
  titleObserverScript,
  type WindowTitleMark,
} from "./window-title.js";
import { CONSOLE_BUDGET, ConsoleBudget } from "./console-budget.js";

const MAX_CONSOLE_ENTRIES = 200;
/** How long a tab over its console budget first stops reading the console; doubles per repeat. */
const CONSOLE_PAUSE_MS = 2_000;
const MAX_CONSOLE_PAUSE_MS = 5 * 60_000;
/** A pause ends only once no event has arrived for this long: Chrome's queue has drained. */
const CONSOLE_QUIET_MS = 500;
/** A page over budget again this soon after a pause ended gets a longer pause. */
const CONSOLE_REPEAT_WINDOW_MS = 30_000;
const LOAD_WAIT_MS = 15_000;
const STORAGE_READ_TIMEOUT_MS = 2_000;
const HIDDEN_TAB_MESSAGE =
  "This tab's page is hidden in the browser (its window is minimized or on another desktop), so it cannot take input. Show its window.";
// A page answers a mouse event in milliseconds; this long means it is not handling input at all.
const INPUT_ACK_TIMEOUT_MS = 5_000;
// How long a page seen visible is trusted before input looks again; pointer moves come at 60 Hz.
const VISIBILITY_TRUST_MS = 500;
const RESTORE_WAIT_MS = 2_000;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800, mobile: false } as const;

export interface ServerBrowserViewport {
  width: number;
  height: number;
  mobile: boolean;
}

export interface ServerBrowserTabOptions {
  browserId: string;
  workspaceId: string;
  contentsId: number;
  targetId: string;
  sessionId: string;
  connection: CdpConnection;
  openedBy: "agent" | "user";
  viewport?: ServerBrowserViewport;
  /** The tab whose page opened this one (window.open, a target=_blank link). */
  openerBrowserId?: string;
  /** Marks the page's title so its window reads as Paseo's (Existing browser only). */
  titleMark?: WindowTitleMark;
  onChange: () => void;
  /** The main frame committed a new document. */
  onNavigated?: (url: string) => void;
  now?: () => number;
}

/**
 * One page target in a workspace's browser context. Implements the desktop engine's TabContents so the
 * vendored automation commands run unchanged, and owns the tab's screencast fan-out.
 */
export class ServerBrowserTab {
  public readonly browserId: string;
  public readonly workspaceId: string;
  public readonly openedBy: "agent" | "user";
  public readonly createdAt: number;
  public readonly contents: TabContents;
  public readonly screencast: ScreencastHub;
  public lastUsedAt: number;

  private targetId: string;
  private sessionId: string;
  private connection: CdpConnection;
  private readonly contentsId: number;
  public readonly titleMark: WindowTitleMark | null;
  public readonly openerBrowserId: string | null;
  private readonly onChange: () => void;
  private readonly onNavigated: (url: string) => void;
  private readonly now: () => number;
  private readonly queue = new CdpSessionQueue();
  private readonly console: BrowserAutomationConsoleLogEntry[] = [];
  /** The seq of console[0]; the buffer drops its oldest line past MAX_CONSOLE_ENTRIES. */
  private consoleFirstSeq = 1;
  private loadWaiters: Array<() => void> = [];
  private url = "about:blank";
  private title = "";
  private loading = false;
  private canGoBack = false;
  private canGoForward = false;
  private viewport: ServerBrowserViewport;
  private closed = false;
  private screencastSize: ScreencastSize | null = null;
  private pendingMove: PendingMove | null = null;
  private loadError: { url: string; errorText?: string } | null = null;
  private dialog: ServerBrowserDialog | null = null;
  private fileChooser: { id: string; multiple: boolean; backendNodeId: number } | null = null;
  private nextDialogId = 1;
  private visibleUntil = 0;
  private readonly consoleBudget = new ConsoleBudget();
  /** Set while the tab is over its console budget and the Runtime domain is off. */
  private consolePause: {
    dropped: number;
    startedAt: number;
    lastDropAt: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private consolePauseMs = CONSOLE_PAUSE_MS;
  private consoleResumedAt = Number.NEGATIVE_INFINITY;

  public constructor(options: ServerBrowserTabOptions) {
    this.browserId = options.browserId;
    this.workspaceId = options.workspaceId;
    this.openedBy = options.openedBy;
    this.contentsId = options.contentsId;
    this.titleMark = options.titleMark ?? null;
    this.openerBrowserId = options.openerBrowserId ?? null;
    this.targetId = options.targetId;
    this.sessionId = options.sessionId;
    this.connection = options.connection;
    this.onChange = options.onChange;
    this.onNavigated = options.onNavigated ?? (() => {});
    this.now = options.now ?? Date.now;
    this.createdAt = this.now();
    this.lastUsedAt = this.createdAt;
    this.viewport = options.viewport ?? { ...DEFAULT_VIEWPORT };
    this.contents = this.createContents();
    this.screencast = new ScreencastHub({
      start: (size) => this.startScreencast(size),
      stop: () => this.stopScreencast(),
    });
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get cdpTargetId(): string {
    return this.targetId;
  }

  public get currentUrl(): string {
    return this.url;
  }

  public get currentViewport(): ServerBrowserViewport {
    return { ...this.viewport };
  }

  public owns(sessionId: string | undefined): boolean {
    return sessionId === this.sessionId;
  }

  public info(): ServerBrowserTabInfo {
    return {
      browserId: this.browserId,
      workspaceId: this.workspaceId,
      url: this.url,
      title: this.title,
      isLoading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      viewport: { ...this.viewport },
      openedBy: this.openedBy,
      createdAt: this.createdAt,
      ...(this.loadError ? { loadError: { ...this.loadError } } : {}),
      ...(this.openerBrowserId ? { openerBrowserId: this.openerBrowserId } : {}),
      ...(this.dialog ? { dialog: { ...this.dialog } } : {}),
      ...(this.fileChooser
        ? { fileChooser: { id: this.fileChooser.id, multiple: this.fileChooser.multiple } }
        : {}),
    };
  }

  public async initialize(): Promise<void> {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    await this.send("Runtime.addBinding", {
      name: TITLE_BINDING,
      executionContextName: TITLE_WORLD,
    });
    await this.send("Page.addScriptToEvaluateOnNewDocument", {
      source: titleObserverScript(this.titleMark),
      worldName: TITLE_WORLD,
      runImmediately: true,
    });
    await this.applyViewport();
  }

  /** Rebinds this browserId to a fresh target after the workspace's context was recreated. */
  public rebind(target: { targetId: string; sessionId: string; connection: CdpConnection }): void {
    this.targetId = target.targetId;
    this.sessionId = target.sessionId;
    this.connection = target.connection;
    this.closed = false;
    // The new target's initialize turns the Runtime domain on again.
    this.endConsolePause();
    this.screencast.resetLastFrame();
    if (this.screencastSize) void this.startScreencast(this.screencastSize);
  }

  public touch(): void {
    this.lastUsedAt = this.now();
  }

  public handleEvent(event: CdpEvent): void {
    if (this.handlePageRequest(event)) return;
    switch (event.method) {
      case "Page.frameNavigated":
        this.onFrameNavigated(event.params);
        return;
      case "Page.navigatedWithinDocument":
        this.url = stringParam(event.params, "url") ?? this.url;
        void this.refreshHistory();
        return;
      case "Page.frameStartedLoading":
        if (this.isMainFrame(event.params)) this.setLoading(true);
        return;
      case "Page.frameStoppedLoading":
        if (this.isMainFrame(event.params)) this.setLoading(false);
        return;
      case "Page.loadEventFired":
        this.setLoading(false);
        void this.refreshTitle();
        // A history traversal can report its entry before the commit lands; read it again.
        void this.refreshHistory();
        if (this.loadError && !this.loadError.errorText)
          void this.readErrorPageCode(this.loadError.url);
        return;
      case "Page.screencastFrame":
        this.onScreencastFrame(event.params);
        return;
      case "Runtime.consoleAPICalled":
        this.onConsole(event.params);
        return;
      case "Runtime.exceptionThrown":
        this.onException(event.params);
        return;
      case "Runtime.bindingCalled":
        if (event.params.name === TITLE_BINDING && typeof event.params.payload === "string") {
          this.updateTargetInfo({ title: event.params.payload });
        }
        return;
      default:
        return;
    }
  }

  public markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.endConsolePause();
    this.screencast.resetLastFrame();
    for (const resolve of this.loadWaiters.splice(0)) resolve();
  }

  public dispose(): void {
    // A pick only ends on an answer, a cancel or its client leaving; a tab that closes,
    // loses its target or its browser while the client stays must end it here.
    cancelPick(this.contents);
    this.markClosed();
    this.screencastSize = null;
    this.screencast.close();
  }

  public updateTargetInfo(info: { url?: string; title?: string }): void {
    let changed = false;
    const title =
      info.title !== undefined && this.titleMark
        ? stripWindowTitle(info.title, this.titleMark)
        : info.title;
    if (title !== undefined && title !== this.title) {
      this.title = title;
      changed = true;
    }
    if (info.url !== undefined && info.url !== this.url && info.url !== "") {
      this.url = info.url;
      changed = true;
    }
    if (changed) this.onChange();
  }

  public async navigate(url: string): Promise<void> {
    this.touch();
    const result = await this.send("Page.navigate", { url });
    const errorText = stringParam(result, "errorText");
    if (errorText && errorText !== "net::ERR_ABORTED") {
      this.setLoadError({ url, errorText });
      throw new Error(`Navigation to ${url} failed: ${errorText}`);
    }
  }

  public async goHistory(delta: -1 | 1): Promise<void> {
    this.touch();
    const history = (await this.send("Page.getNavigationHistory")) as {
      currentIndex: number;
      entries: Array<{ id: number }>;
    };
    const entry = history.entries[history.currentIndex + delta];
    if (entry) await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  }

  public async reload(): Promise<void> {
    this.touch();
    await this.send("Page.reload");
  }

  /** A viewer's answer to the page's open dialog. */
  public async answerDialog(answer: {
    dialogId: string;
    accept: boolean;
    promptText?: string;
  }): Promise<void> {
    if (this.dialog?.id !== answer.dialogId) throw new Error("This dialog is already answered.");
    this.touch();
    this.dialog = null;
    this.onChange();
    await this.answerPage({ accept: answer.accept, promptText: answer.promptText ?? "" });
  }

  /**
   * A viewer's answer to the page's file chooser: the paths of the files it uploaded to the host,
   * or none to cancel.
   */
  public async answerFileChooser(chooserId: string, paths: readonly string[]): Promise<void> {
    const chooser = this.fileChooser;
    if (chooser?.id !== chooserId) throw new Error("This file chooser is already answered.");
    this.touch();
    this.fileChooser = null;
    this.onChange();
    if (paths.length === 0) return;
    await this.send("DOM.setFileInputFiles", {
      files: chooser.multiple ? [...paths] : paths.slice(0, 1),
      backendNodeId: chooser.backendNodeId,
    });
  }

  /** A note in the tab's console, where agents (browser_logs) and the console panel see it. */
  public warn(message: string): void {
    this.recordConsole("warning", message);
  }

  /** The viewer's logs panel: console lines after `after` (a seq), oldest first. */
  public consoleSince(after = 0): ServerBrowserConsoleEntry[] {
    const start = Math.max(0, after + 1 - this.consoleFirstSeq);
    const entries: ServerBrowserConsoleEntry[] = [];
    for (let index = start; index < this.console.length; index++) {
      entries.push(Object.assign({ seq: this.consoleFirstSeq + index }, this.console[index]));
    }
    return entries;
  }

  /** The toolbar's Stop: ends the load, keeping what the page has shown so far. */
  public async stopLoading(): Promise<void> {
    this.touch();
    await this.send("Page.stopLoading");
  }

  public async setViewport(viewport: ServerBrowserViewport): Promise<void> {
    this.viewport = { ...viewport };
    await this.applyViewport();
    this.onChange();
  }

  /** Applies viewer input. Pointer coordinates are fractions of the frame. */
  public async dispatchInput(events: ServerBrowserInputEvent[]): Promise<void> {
    this.touch();
    this.assertNoDialog();
    const last = events.at(-1);
    if (last && events.every(isPointerMove)) {
      // A pointer reports moves faster than a slow page acknowledges them. Queued moves would
      // hold every later click, key and pick poll behind them, so a move still waiting for its
      // slot takes the newest position instead of queueing another.
      if (this.pendingMove) {
        this.pendingMove.event = last;
        return this.pendingMove.done;
      }
      const slot: PendingMove = { event: last, done: Promise.resolve() };
      this.pendingMove = slot;
      slot.done = this.queue.run(async () => {
        if (this.pendingMove === slot) this.pendingMove = null;
        await this.dispatchOne(slot.event);
      });
      return slot.done;
    }
    // A later move must not jump ahead of this batch into an earlier slot.
    this.pendingMove = null;
    // One queue slot per batch, taken synchronously: a later request's mouse-up must not
    // overtake this request's mouse-down while it awaits the move before it.
    await this.queue.run(async () => {
      for (const event of events) await this.dispatchOne(event);
    });
  }

  private async dispatchOne(event: ServerBrowserInputEvent): Promise<void> {
    switch (event.kind) {
      case "mouse": {
        const type = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" }[
          event.action
        ];
        await this.inputSend("Input.dispatchMouseEvent", {
          type,
          ...this.toPagePoint(event.x, event.y),
          button: event.button,
          buttons: event.action === "up" || event.button === "none" ? 0 : buttonMask(event.button),
          clickCount: event.clickCount,
          modifiers: modifierMask(event.modifiers),
        });
        return;
      }
      case "wheel":
        await this.inputSend("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...this.toPagePoint(event.x, event.y),
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        });
        return;
      case "key":
        await this.inputSend("Input.dispatchKeyEvent", {
          type: cdpKeyEventType(event.action, event.text),
          key: event.key,
          code: event.code,
          windowsVirtualKeyCode: event.keyCode,
          ...(event.action === "down" && event.text ? { text: event.text } : {}),
          modifiers: modifierMask(event.modifiers),
        });
        return;
      case "text":
        await this.inputSend("Input.insertText", { text: event.text });
        return;
    }
  }

  private toPagePoint(x: number, y: number): { x: number; y: number } {
    const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    return { x: clamp(x) * this.viewport.width, y: clamp(y) * this.viewport.height };
  }

  private createContents(): TabContents {
    return {
      id: this.contentsId,
      getURL: () => this.url,
      getTitle: () => this.title,
      canGoBack: () => this.canGoBack,
      canGoForward: () => this.canGoForward,
      isLoading: () => this.loading,
      isDestroyed: () => this.closed,
      executeJavaScript: (code) => this.evaluate(code),
      loadURL: (url) => this.loadUrl(url),
      goBack: () => void this.goHistory(-1).catch(() => {}),
      goForward: () => void this.goHistory(1).catch(() => {}),
      reload: () => void this.reload().catch(() => {}),
      captureFrame: () => this.captureFrame(),
      invalidate: () => {},
      withFrameProduction: (capture) => capture(),
      sendInputEvent: (event) => this.sendElectronKey(event),
      insertText: async (text) => {
        await this.send("Input.insertText", { text });
      },
      getConsoleMessages: () => [...this.console],
      sendDebugCommand: (command, params) => this.send(command, params ?? {}),
    };
  }

  private async evaluate(code: string): Promise<unknown> {
    this.touch();
    const result = (await this.send("Runtime.evaluate", {
      expression: code,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Script failed";
      throw new Error(description);
    }
    return result.result?.value;
  }

  /**
   * The page's origin and its localStorage, for saving the workspace's storage. Bypasses the
   * command queue so a long agent command cannot hold up a save; null when the page is busy.
   */
  public async readLocalStorage(): Promise<{ origin: string; items: LocalStorageItems } | null> {
    if (this.closed || !/^https?:/.test(this.url)) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), STORAGE_READ_TIMEOUT_MS);
    });
    const read = this.rawSend("Runtime.evaluate", {
      expression: "JSON.stringify([location.origin, Object.entries(localStorage)])",
      returnByValue: true,
    }).then((result) => {
      const value = (result.result as { value?: unknown } | undefined)?.value;
      if (typeof value !== "string") return null;
      const [origin, items] = JSON.parse(value) as [string, LocalStorageItems];
      return origin.startsWith("http") ? { origin, items } : null;
    });
    try {
      return await Promise.race([read.catch(() => null), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Opens the tab's first page. The target starts at about:blank so the viewport and scripts are
   * in place before any page runs; that blank entry then leaves the history, so Back never leads
   * to an empty page.
   */
  public async loadFirstPage(url: string): Promise<void> {
    await this.loadUrl(url);
    await this.send("Page.resetNavigationHistory");
    await this.refreshHistory();
  }

  private async loadUrl(url: string): Promise<void> {
    const loaded = this.waitForLoad();
    await this.navigate(url);
    await loaded;
    await this.refreshTitle();
  }

  /** Resolves on the next main-frame load, or after LOAD_WAIT_MS for a page that never finishes. */
  private waitForLoad(): Promise<void> {
    let release = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.loadWaiters.push(release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LOAD_WAIT_MS);
    });
    return Promise.race([loaded, timeout]).finally(() => {
      clearTimeout(timer);
      this.loadWaiters = this.loadWaiters.filter((waiter) => waiter !== release);
    });
  }

  private async captureFrame(): Promise<TabImage> {
    const result = (await this.send("Page.captureScreenshot", { format: "png" })) as {
      data: string;
    };
    const png = Buffer.from(result.data, "base64");
    const size = pngSize(png);
    return { toPNG: () => png, getSize: () => size };
  }

  private sendElectronKey(event: IsolatedKeyboardInputEvent): void {
    for (const params of cdpKeyEventsForElectronKey(event)) {
      void this.send("Input.dispatchKeyEvent", params).catch(() => {});
    }
  }

  /**
   * The page takes no input until its dialog closes, and the command that opened the dialog holds
   * the queue meanwhile, so input fails here, before it would queue behind it.
   */
  private assertNoDialog(): void {
    if (!this.dialog) return;
    throw new Error(
      `A ${this.dialog.type} dialog is open on this page ("${this.dialog.message}") and waits for the user's answer in the Paseo viewer.`,
    );
  }

  private send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    if (method.startsWith("Input.")) {
      this.assertNoDialog();
      return this.queue.run(() => this.inputSend(method, params));
    }
    return this.queue.run(() => this.rawSend(method, params));
  }

  /**
   * An input event, sent once the page can take it. Chromium answers an input command only after
   * the page handled the event, and a hidden page (its window minimized, or on another desktop)
   * never does: the command would hold the tab's queue, and every later command, forever.
   */
  private async inputSend(method: string, params: CdpParams): Promise<CdpParams> {
    this.assertNoDialog();
    await this.ensureVisible();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Look again on the next event: the page may have been hidden since the last look.
        this.visibleUntil = 0;
        reject(new Error(HIDDEN_TAB_MESSAGE));
      }, INPUT_ACK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.rawSend(method, params), stalled]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Restores the tab's window when it is minimized; throws when its page stays hidden. */
  private async ensureVisible(): Promise<void> {
    if (Date.now() < this.visibleUntil) return;
    if ((await this.visibilityState()) === "hidden") {
      await this.restoreWindow();
      if ((await this.visibilityState()) === "hidden") throw new Error(HIDDEN_TAB_MESSAGE);
    }
    this.visibleUntil = Date.now() + VISIBILITY_TRUST_MS;
  }

  private async visibilityState(): Promise<unknown> {
    const result = await this.rawSend("Runtime.evaluate", {
      expression: "document.visibilityState",
      returnByValue: true,
    });
    return (result.result as { value?: unknown } | undefined)?.value;
  }

  /**
   * A headed browser hides the page of a minimized window, and its owner minimizes windows. Any
   * use from a viewer or an agent brings it back; the window takes focus on its desktop as it does.
   * A browser with no windows (headless) fails getWindowForTarget, and nothing changes.
   */
  private async restoreWindow(): Promise<void> {
    const found = (await this.connection
      .send("Browser.getWindowForTarget", { targetId: this.targetId })
      .catch(() => null)) as { windowId?: number; bounds?: { windowState?: string } } | null;
    if (typeof found?.windowId !== "number" || found.bounds?.windowState !== "minimized") return;
    await this.connection
      .send("Browser.setWindowBounds", {
        windowId: found.windowId,
        bounds: { windowState: "normal" },
      })
      .catch(() => {});
    // Chromium shows the page a moment after the window manager maps the window.
    const deadline = Date.now() + RESTORE_WAIT_MS;
    while (Date.now() < deadline && (await this.visibilityState()) === "hidden") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private rawSend(method: string, params: CdpParams = {}): Promise<CdpParams> {
    if (this.closed) return Promise.reject(new Error("Browser tab has been closed"));
    return this.connection.send(method, params, this.sessionId);
  }

  private async applyViewport(): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: this.viewport.mobile ? 2 : 1,
      mobile: this.viewport.mobile,
    });
    await this.send("Emulation.setTouchEmulationEnabled", {
      enabled: this.viewport.mobile,
      ...(this.viewport.mobile ? { maxTouchPoints: 5 } : {}),
    });
  }

  private startScreencast(size: ScreencastSize): void {
    this.screencastSize = size;
    // A hidden page paints nothing, so a viewer of a minimized window would wait on a blank frame.
    void this.ensureVisible().catch(() => {});
    // A file input asks the viewer instead of opening Chromium's chooser, which no one sees.
    void this.rawSend("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
    void this.rawSend("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: size.maxWidth,
      maxHeight: size.maxHeight,
      everyNthFrame: 1,
    }).catch(() => {});
  }

  private stopScreencast(): void {
    this.screencastSize = null;
    // With no viewer the page keeps Chromium's own chooser (an Existing browser's owner sees it).
    void this.rawSend("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    if (this.fileChooser) {
      this.fileChooser = null;
      this.onChange();
    }
    // The last viewer left; nobody is there to answer.
    if (this.dialog) {
      const dialog = this.dialog;
      this.dialog = null;
      this.autoAcceptDialog(dialog);
      this.onChange();
    }
    void this.rawSend("Page.stopScreencast").catch(() => {});
  }

  private onScreencastFrame(params: CdpParams): void {
    const data = stringParam(params, "data");
    const frameSessionId = params.sessionId;
    if (!data || typeof frameSessionId !== "number") return;
    const metadata = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
    const ack = () => {
      void this.rawSend("Page.screencastFrameAck", { sessionId: frameSessionId }).catch(() => {});
    };
    // A screenshot with a clip (Annotate's crop, an agent's element shot) resizes the view for the
    // capture, and Chromium screencasts that clip-sized frame too; a viewer would stretch it over
    // the page and keep it until the next paint. The last page-sized frame stays on screen instead.
    if (
      metadata.deviceWidth !== undefined &&
      metadata.deviceHeight !== undefined &&
      (Math.abs(metadata.deviceWidth - this.viewport.width) > 1 ||
        Math.abs(metadata.deviceHeight - this.viewport.height) > 1)
    ) {
      ack();
      return;
    }
    this.screencast.pushFrame(
      {
        jpeg: Buffer.from(data, "base64"),
        width: metadata.deviceWidth ?? this.viewport.width,
        height: metadata.deviceHeight ?? this.viewport.height,
      },
      ack,
    );
  }

  private onFrameNavigated(params: CdpParams): void {
    const frame = params.frame as
      | { parentId?: string; url?: string; urlFragment?: string; unreachableUrl?: string }
      | undefined;
    if (!frame || frame.parentId) return;
    // A failed load commits Chromium's error page; the tab keeps the URL it tried.
    const unreachableUrl = typeof frame.unreachableUrl === "string" ? frame.unreachableUrl : null;
    this.url = unreachableUrl ?? `${frame.url ?? this.url}${frame.urlFragment ?? ""}`;
    if (unreachableUrl) {
      if (this.loadError?.url !== unreachableUrl) this.loadError = { url: unreachableUrl };
    } else {
      this.loadError = null;
    }
    this.onChange();
    this.onNavigated(this.url);
    void this.refreshHistory();
  }

  /** What the page asks the user: a dialog to answer, files to pick. */
  private handlePageRequest(event: CdpEvent): boolean {
    switch (event.method) {
      case "Page.fileChooserOpened":
        this.onFileChooserOpened(event.params);
        return true;
      case "Page.javascriptDialogOpening":
        this.onDialogOpening(event.params);
        return true;
      case "Page.javascriptDialogClosed":
        // Answered here, or in the window of an Existing browser by its owner.
        if (this.dialog) {
          this.dialog = null;
          this.onChange();
        }
        return true;
      default:
        return false;
    }
  }

  /**
   * A dialog waits for the user while a viewer watches, as in the other Browsers. With no one
   * watching (an agent alone, or the last viewer left) it is accepted, so it cannot hold the page.
   */
  private onDialogOpening(params: CdpParams): void {
    const dialog: ServerBrowserDialog = {
      id: String(this.nextDialogId++),
      type: stringParam(params, "type") ?? "alert",
      message: stringParam(params, "message") ?? "",
      ...(stringParam(params, "defaultPrompt") !== undefined
        ? { defaultPrompt: stringParam(params, "defaultPrompt") }
        : {}),
      url: stringParam(params, "url") ?? this.url,
    };
    if (this.screencast.viewerCount === 0) {
      this.autoAcceptDialog(dialog);
      return;
    }
    this.dialog = dialog;
    this.recordConsole("warning", `Dialog waiting for the user: ${dialog.message}`);
    this.onChange();
  }

  /**
   * The page's file input opened a chooser, which Chromium shows to nobody while it is
   * intercepted (only while a viewer watches): the viewer picks files on its own device.
   * showOpenFilePicker has no input to set, so only an <input type=file> gets one.
   */
  private onFileChooserOpened(params: CdpParams): void {
    const backendNodeId = params.backendNodeId;
    if (typeof backendNodeId !== "number" || this.screencast.viewerCount === 0) return;
    this.fileChooser = {
      id: String(this.nextDialogId++),
      multiple: params.mode === "selectMultiple",
      backendNodeId,
    };
    this.onChange();
  }

  private autoAcceptDialog(dialog: ServerBrowserDialog): void {
    void this.answerPage({ accept: true, promptText: dialog.defaultPrompt ?? "" }).catch(() => {});
    this.recordConsole("warning", `Dialog auto-accepted: ${dialog.message}`);
  }

  /**
   * Outside the tab's queue: the command that opened the dialog (a click, an evaluate) gets no
   * answer until the dialog closes, and this answer would wait behind it forever.
   */
  private answerPage(answer: { accept: boolean; promptText: string }): Promise<CdpParams> {
    return this.rawSend("Page.handleJavaScriptDialog", answer);
  }

  private setLoadError(error: { url: string; errorText?: string }): void {
    this.loadError = error;
    this.onChange();
  }

  /**
   * A load the page started (a link, a redirect) has no Page.navigate answer. Chrome's error page
   * names the error; the headless shell's is empty, so there the failure keeps only its URL.
   */
  private async readErrorPageCode(url: string): Promise<void> {
    try {
      const code = await this.evaluate(
        'document.querySelector(".error-code")?.textContent?.trim() ?? ""',
      );
      if (
        typeof code === "string" &&
        code &&
        this.loadError?.url === url &&
        !this.loadError.errorText
      ) {
        this.setLoadError({ url, errorText: code.startsWith("net::") ? code : `net::${code}` });
      }
    } catch {
      // The page moved on.
    }
  }

  private isMainFrame(params: CdpParams): boolean {
    return params.frameId === this.targetId;
  }

  private setLoading(loading: boolean): void {
    if (this.loading === loading) return;
    this.loading = loading;
    if (!loading) for (const resolve of this.loadWaiters.splice(0)) resolve();
    this.onChange();
  }

  private async refreshHistory(): Promise<void> {
    try {
      const history = (await this.send("Page.getNavigationHistory")) as {
        currentIndex: number;
        entries: unknown[];
      };
      this.canGoBack = history.currentIndex > 0;
      this.canGoForward = history.currentIndex < history.entries.length - 1;
      this.onChange();
    } catch {
      // The tab closed mid-refresh.
    }
  }

  private async refreshTitle(): Promise<void> {
    try {
      const title = await this.evaluate("document.title");
      if (typeof title === "string") this.updateTargetInfo({ title });
    } catch {
      // The page navigated away mid-read.
    }
  }

  private onConsole(params: CdpParams): void {
    const args =
      (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
    const message = args
      .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? "")))
      .join(" ");
    if (!this.admitConsole(message)) return;
    const level = typeof params.type === "string" ? params.type : "log";
    this.recordConsole(level === "warning" ? "warning" : level, message);
  }

  private onException(params: CdpParams): void {
    const details = params.exceptionDetails as
      | { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number }
      | undefined;
    const message = details?.exception?.description ?? details?.text ?? "Uncaught";
    if (!this.admitConsole(message)) return;
    this.recordConsole("error", message, {
      ...(details?.url ? { source: details.url } : {}),
      ...(typeof details?.lineNumber === "number" ? { line: details.lineNumber } : {}),
    });
  }

  /**
   * Whether a console message from the page is kept. Past the budget the tab turns the Runtime
   * domain off, so the page stops sending events, and counts what still arrives as dropped. The
   * page has usually queued many more before the off reaches it, so the tab turns the domain back
   * on only after the pause and once those stopped arriving, and says how many it dropped. A page
   * that is over budget again soon after gets twice the pause, up to MAX_CONSOLE_PAUSE_MS.
   */
  private admitConsole(message: string): boolean {
    const now = this.now();
    if (this.consolePause) {
      this.consolePause.dropped += 1;
      this.consolePause.lastDropAt = now;
      return false;
    }
    if (this.consoleBudget.admit(now, message.length)) return true;
    this.consolePauseMs =
      now - this.consoleResumedAt < CONSOLE_REPEAT_WINDOW_MS
        ? Math.min(this.consolePauseMs * 2, MAX_CONSOLE_PAUSE_MS)
        : CONSOLE_PAUSE_MS;
    this.consolePause = {
      dropped: 1,
      startedAt: now,
      lastDropAt: now,
      timer: setTimeout(() => this.resumeConsoleWhenQuiet(), this.consolePauseMs),
    };
    // Straight to the browser: the tab's queue may be held by a command the busy page delays.
    void this.rawSend("Runtime.disable").catch(() => {});
    return false;
  }

  private resumeConsoleWhenQuiet(): void {
    const pause = this.consolePause;
    if (!pause) return;
    const quietFor = this.now() - pause.lastDropAt;
    if (quietFor < CONSOLE_QUIET_MS) {
      pause.timer = setTimeout(() => this.resumeConsoleWhenQuiet(), CONSOLE_QUIET_MS - quietFor);
      return;
    }
    void this.resumeConsole();
  }

  private async resumeConsole(): Promise<void> {
    const pause = this.consolePause;
    if (!pause) return;
    // Chromium keeps the page's console while the domain is off and replays all of it on enable.
    await this.rawSend("Runtime.discardConsoleEntries").catch(() => {});
    await this.rawSend("Runtime.enable").catch(() => {});
    if (this.consolePause !== pause) return;
    this.consolePause = null;
    this.consoleBudget.reset();
    this.consoleResumedAt = this.now();
    const seconds = Math.round((this.consoleResumedAt - pause.startedAt) / 1000);
    this.recordConsole(
      "warning",
      `${pause.dropped} console messages dropped: the page logged more than ${CONSOLE_BUDGET.messages} a second, so Paseo stopped reading its console for ${seconds} s. Messages logged in that time are not counted.`,
    );
  }

  private endConsolePause(): void {
    if (this.consolePause) clearTimeout(this.consolePause.timer);
    this.consolePause = null;
    this.consoleBudget.reset();
  }

  private recordConsole(
    level: string,
    message: string,
    extra: { source?: string; line?: number } = {},
  ): void {
    this.console.push({ level, message, timestamp: this.now(), ...extra });
    if (this.console.length > MAX_CONSOLE_ENTRIES) {
      this.console.shift();
      this.consoleFirstSeq += 1;
    }
  }
}

type ServerBrowserDialog = NonNullable<ServerBrowserTabInfo["dialog"]>;

interface PendingMove {
  event: ServerBrowserInputEvent;
  done: Promise<void>;
}

function isPointerMove(event: ServerBrowserInputEvent): boolean {
  return event.kind === "mouse" && event.action === "move";
}

function cdpKeyEventType(action: "down" | "up", text: string | undefined): string {
  if (action === "up") return "keyUp";
  // A keyDown with text inserts it; rawKeyDown leaves text to a separate char/insertText.
  return text ? "keyDown" : "rawKeyDown";
}

function stringParam(params: CdpParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

function modifierMask(modifiers: Array<keyof typeof MODIFIER_BITS> | undefined): number {
  return (modifiers ?? []).reduce((mask, modifier) => mask | MODIFIER_BITS[modifier], 0);
}

function buttonMask(button: "left" | "right" | "middle"): number {
  return { left: 1, right: 2, middle: 4 }[button];
}

function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
