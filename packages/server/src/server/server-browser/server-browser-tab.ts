import type { BrowserAutomationConsoleLogEntry } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type {
  ServerBrowserConsoleEntry,
  ServerBrowserInputEvent,
  ServerBrowserTab as ServerBrowserTabInfo,
} from "@getpaseo/protocol/server-browser/rpc-schemas";
import type { CdpConnection, CdpEvent, CdpParams } from "./cdp-connection.js";
import { CdpSessionQueue } from "./engine/cdp-session-queue.js";
import {
  BrowserTabClosedError,
  PageNavigatedError,
  type TabContents,
  type TabImage,
} from "./engine/service.js";
import type { IsolatedKeyboardInputEvent } from "./engine/trusted-input.js";
import { ScreencastHub, type ScreencastFrame, type ScreencastSize } from "./screencast-hub.js";
import type { TabVideoCapture } from "./tab-video.js";
import { TabVideoStream } from "./tab-video-stream.js";
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
import { LoopbackPortSet } from "./loopback-ports.js";

const MAX_CONSOLE_ENTRIES = 200;
/** How long a tab over its console budget first stops reading the console; doubles per repeat. */
const CONSOLE_PAUSE_MS = 2_000;
const MAX_CONSOLE_PAUSE_MS = 5 * 60_000;
/** A pause ends only once no event has arrived for this long: Chrome's queue has drained. */
const CONSOLE_QUIET_MS = 500;
/** A page over budget again this soon after a pause ended gets a longer pause. */
const CONSOLE_REPEAT_WINDOW_MS = 30_000;
const LOAD_WAIT_MS = 15_000;
// A new tab answers within the daemon broker's 15 s even when its server is slow to send the page.
const FIRST_PAGE_WAIT_MS = 10_000;
// How long a script's lost context may come before its page reports the commit that lost it.
const COMMIT_REPORT_WAIT_MS = 1_000;
// Chromium holds every command bound for the page while a navigation waits for its document,
// and runs it on the new document once that commits. Wait that long at most, then say so.
const PENDING_DOCUMENT_WAIT_MS = 8_000;
const PAGE_BOUND_COMMAND = /^(Runtime|DOM|Accessibility|CSS|Overlay|Input)\./;
const LOST_CONTEXT = /Execution context was destroyed|Inspected target navigated or closed/;
const STORAGE_READ_TIMEOUT_MS = 2_000;
const HIDDEN_TAB_MESSAGE =
  "This tab's page is hidden in the browser (its window is minimized or on another desktop), so it cannot take input. Show its window.";
// A page answers a mouse event in milliseconds; this long means it is not handling input at all.
const INPUT_ACK_TIMEOUT_MS = 5_000;
// How long a page seen visible is trusted before input looks again; pointer moves come at 60 Hz.
const VISIBILITY_TRUST_MS = 500;
const RESTORE_WAIT_MS = 2_000;
/** How long suspending waits for the page's scroll position and a final frame. */
const SUSPEND_CAPTURE_TIMEOUT_MS = 3_000;
/** A restored page's layout can grow after load (a SPA rendering); scrolling retries this long. */
const SCROLL_RESTORE_MS = 3_000;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800, mobile: false } as const;
export const CRASHED_TAB_MESSAGE =
  "This tab's page crashed. Reload the tab (browser_reload, or Reload in the viewer) to bring it back.";
// A crashed renderer answers nothing it would have handled: commands hang until the page reloads.
// These run in the browser process and still answer, so a crashed tab can be reloaded or moved.
const CRASH_SAFE_METHODS = new Set([
  "Page.reload",
  "Page.navigate",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.resetNavigationHistory",
]);

export interface ServerBrowserViewport {
  width: number;
  height: number;
  mobile: boolean;
}

/** A page target the tab drives. */
export interface ServerBrowserTabTarget {
  targetId: string;
  sessionId: string;
  connection: CdpConnection;
}

/** What a suspended tab keeps of its page once the target is gone. */
export interface TabSuspension {
  suspendedAt: number;
  scroll: { x: number; y: number };
  /** The page as it was left; null when it could not be captured. */
  frame: ScreencastFrame | null;
}

/** A suspended tab read back from disk after a daemon restart. */
export interface SuspendedTabRecord {
  url: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  suspension: TabSuspension;
}

export interface ServerBrowserTabOptions {
  browserId: string;
  workspaceId: string;
  contentsId: number;
  /** Null for a tab that starts suspended (read back from disk). */
  target: ServerBrowserTabTarget | null;
  suspended?: SuspendedTabRecord;
  openedBy: "agent" | "user";
  viewport?: ServerBrowserViewport;
  /** The tab whose page opened this one (window.open, a target=_blank link). */
  openerBrowserId?: string;
  /** Marks the page's title so its window reads as Paseo's (Existing browser only). */
  titleMark?: WindowTitleMark;
  onChange: () => void;
  /** The main frame committed a new document. */
  onNavigated?: (url: string) => void;
  /** The browser's tab-capture extension, when the engine has one (Managed Chrome). */
  videoCapture?: () => Promise<TabVideoCapture | null>;
  onVideoError?: (message: string) => void;
  onVideoPlan?: (encodes: string[]) => void;
  /** Reloads a suspended tab's page; the tab calls it when a viewer or a command needs the page. */
  onWake?: () => Promise<void>;
  now?: () => number;
}

interface DocumentWaiter {
  /** The navigation's document committed; its DOM-ready settles the wait. */
  committed: boolean;
  promise: Promise<void>;
  settle: () => void;
  fail: (error: Error) => void;
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
  public readonly video: TabVideoStream | null;
  public lastUsedAt: number;

  private targetId: string;
  private sessionId: string;
  private connection: CdpConnection | null;
  private readonly contentsId: number;
  public readonly titleMark: WindowTitleMark | null;
  public readonly openerBrowserId: string | null;
  private readonly onChange: () => void;
  private readonly onNavigated: (url: string) => void;
  private readonly onWake: () => Promise<void>;
  private readonly now: () => number;
  /** Set while the tab is suspended: its target is closed and its page unloaded. */
  private suspension: TabSuspension | null = null;
  /**
   * A user pinned the tab in their tab bar: it may suspend, but nothing closes it automatically
   * (the suspended-tab cap and age) and an agent's browser_close_tab is refused.
   */
  private pinnedByUser = false;
  /** The suspended page's frame, shown to viewers until the restored page paints. */
  private stillFrame: ScreencastFrame | null = null;
  private readonly queue = new CdpSessionQueue();
  private readonly console: BrowserAutomationConsoleLogEntry[] = [];
  /** The seq of console[0]; the buffer drops its oldest line past MAX_CONSOLE_ENTRIES. */
  private consoleFirstSeq = 1;
  private loadWaiters: Array<() => void> = [];
  private documentWaiters: DocumentWaiter[] = [];
  /** Main-frame documents committed so far; a script that sees this change lost its page. */
  private committedDocuments = 0;
  /** A main-frame navigation started and its document has not committed yet. */
  private documentPending = false;
  private url = "about:blank";
  private title = "";
  private loading = false;
  private canGoBack = false;
  private canGoForward = false;
  private viewport: ServerBrowserViewport;
  private closed = false;
  /** The page's renderer crashed; it stays crashed until the page reloads or navigates. */
  private crashed = false;
  /** Rejecters of commands awaiting an answer, failed at once when the renderer crashes. */
  private readonly inFlight = new Set<(error: Error) => void>();
  private screencastSize: ScreencastSize | null = null;
  private pendingMove: PendingMove | null = null;
  private loadError: { url: string; errorText?: string } | null = null;
  private dialog: ServerBrowserDialog | null = null;
  private fileChooser: { id: string; multiple: boolean; backendNodeId: number } | null = null;
  private nextDialogId = 1;
  private visibleUntil = 0;
  private readonly consoleBudget = new ConsoleBudget();
  private readonly loopbackPorts = new LoopbackPortSet();
  /**
   * Sessions of the page's workers and out-of-process frames. A request a service worker makes
   * for the page is reported on the worker's target, not the page's, so its port is read there.
   */
  private readonly childSessions = new Set<string>();
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
    this.targetId = options.target?.targetId ?? "";
    this.sessionId = options.target?.sessionId ?? "";
    this.connection = options.target?.connection ?? null;
    this.onChange = options.onChange;
    this.onNavigated = options.onNavigated ?? (() => {});
    this.onWake = options.onWake ?? (() => Promise.reject(new Error("This tab is suspended.")));
    this.now = options.now ?? Date.now;
    this.createdAt = options.suspended?.createdAt ?? this.now();
    this.lastUsedAt = options.suspended?.lastUsedAt ?? this.createdAt;
    if (options.suspended) {
      this.url = options.suspended.url;
      this.title = options.suspended.title;
      this.suspension = options.suspended.suspension;
      this.stillFrame = this.suspension.frame;
    }
    this.viewport = options.viewport ?? { ...DEFAULT_VIEWPORT };
    this.contents = this.createContents();
    this.screencast = new ScreencastHub({
      start: (size) => this.startScreencast(size),
      stop: () => this.stopScreencast(),
      stillFrame: () => this.stillFrame,
    });
    const videoCapture = options.videoCapture;
    this.video = videoCapture
      ? new TabVideoStream({
          capture: videoCapture,
          targetId: () => this.targetId,
          page: () => ({
            width: this.viewport.width,
            height: this.viewport.height,
            scale: this.viewport.mobile ? 2 : 1,
          }),
          onWatched: (watched) => (watched ? this.beginWatching() : this.endWatching()),
          onError: (message) => options.onVideoError?.(message),
          onPlan: (encodes) => options.onVideoPlan?.(encodes),
        })
      : null;
  }

  /** Viewers of either stream: JPEG frames or video. */
  public get viewerCount(): number {
    return this.screencast.viewerCount + (this.video?.hub.viewerCount ?? 0);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get isSuspended(): boolean {
    return this.suspension !== null;
  }

  public get suspendedState(): TabSuspension | null {
    return this.suspension;
  }

  /** The frame a suspended (or just restored) tab shows until its page paints. */
  public get currentStillFrame(): ScreencastFrame | null {
    return this.stillFrame;
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
    return (
      sessionId === this.sessionId || (sessionId !== undefined && this.childSessions.has(sessionId))
    );
  }

  public get pinned(): boolean {
    return this.pinnedByUser;
  }

  public setPinned(pinned: boolean): void {
    if (this.pinnedByUser === pinned) return;
    this.pinnedByUser = pinned;
    this.onChange();
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
      ...(this.suspension ? { suspended: true } : {}),
      ...(this.pinnedByUser ? { pinned: true } : {}),
      ...(this.loadError ? { loadError: { ...this.loadError } } : {}),
      ...(this.crashed ? { crashed: true } : {}),
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
    // For the loopback ports the page uses (Open on this computer). No bodies are kept: nothing
    // reads them, and the default buffers hold up to 100 MB per tab.
    await this.send("Network.enable", {
      maxTotalBufferSize: 0,
      maxResourceBufferSize: 0,
      maxPostDataSize: 0,
    });
    // Attach to the page's workers and frames (not paused) to read their Network events too.
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
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
  /**
   * `videoAfterLoad`: a woken tab's video starts once its page has loaded (startVideo), because a
   * capture started on the new target's blank page can end with the load.
   */
  public rebind(target: ServerBrowserTabTarget, options: { videoAfterLoad?: boolean } = {}): void {
    this.targetId = target.targetId;
    this.sessionId = target.sessionId;
    this.connection = target.connection;
    this.closed = false;
    this.suspension = null;
    // A new target has a new renderer, and its own workers.
    this.crashed = false;
    this.childSessions.clear();
    this.documentPending = false;
    // The new target's initialize turns the Runtime domain on again.
    this.endConsolePause();
    this.screencast.resetLastFrame();
    if (this.screencastSize) void this.startScreencast(this.screencastSize);
    if (!options.videoAfterLoad) this.video?.refresh();
  }

  /** Starts (or restarts) video capture for this tab's current target. */
  public startVideo(): void {
    this.video?.refresh();
  }

  public touch(): void {
    this.lastUsedAt = this.now();
  }

  public handleEvent(event: CdpEvent): void {
    if (this.handleTraffic(event)) return;
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
        if (this.isMainFrame(event.params)) {
          this.documentPending = true;
          this.setLoading(true);
        }
        return;
      case "Page.frameStoppedLoading":
        if (this.isMainFrame(event.params)) {
          this.documentPending = false;
          this.setLoading(false);
        }
        return;
      case "Page.domContentEventFired":
        this.onDomContentLoaded();
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

  /**
   * Where the page is now, for suspending it: its scroll position and a frame of what it shows.
   * A page too busy to answer keeps the last screencast frame, or none.
   */
  public async captureSuspension(): Promise<TabSuspension> {
    const scroll = await withDeadline(
      this.rawSend("Runtime.evaluate", {
        expression: "[window.scrollX, window.scrollY]",
        returnByValue: true,
      }).then((result) => {
        const value = (result.result as { value?: unknown } | undefined)?.value;
        return Array.isArray(value) && value.every((n) => typeof n === "number")
          ? { x: value[0] as number, y: value[1] as number }
          : null;
      }),
      SUSPEND_CAPTURE_TIMEOUT_MS,
    );
    const shot = await withDeadline(
      this.rawSend("Page.captureScreenshot", { format: "jpeg", quality: 60 }).then((result) =>
        typeof result.data === "string" ? Buffer.from(result.data, "base64") : null,
      ),
      SUSPEND_CAPTURE_TIMEOUT_MS,
    );
    const frame = shot
      ? { jpeg: shot, width: this.viewport.width, height: this.viewport.height }
      : (this.screencast.currentFrame ?? this.stillFrame);
    return { suspendedAt: this.now(), scroll: scroll ?? { x: 0, y: 0 }, frame };
  }

  /**
   * The page goes away and the tab keeps its URL, title, size and last frame. Its target must be
   * closed by the caller; the next viewer or command wakes it (onWake), which reloads the page.
   */
  public suspend(suspension: TabSuspension): void {
    cancelPick(this.contents);
    this.suspension = suspension;
    this.stillFrame = suspension.frame;
    this.targetId = "";
    this.sessionId = "";
    this.connection = null;
    this.crashed = false;
    this.childSessions.clear();
    this.endConsolePause();
    this.loading = false;
    this.canGoBack = false;
    this.canGoForward = false;
    this.dialog = null;
    this.fileChooser = null;
    this.pendingMove = null;
    this.visibleUntil = 0;
    this.documentPending = false;
    for (const resolve of this.loadWaiters.splice(0)) resolve();
    this.failDocumentWaiters(new Error("The tab was suspended before its page loaded."));
    this.onChange();
  }

  /** The restored page painted (or never will): viewers get live frames only from here on. */
  public dropStillFrame(): void {
    this.stillFrame = null;
  }

  /** Scrolls a restored page back to where it was suspended, waiting for its layout to grow. */
  public async restoreScroll(scroll: { x: number; y: number }): Promise<void> {
    if (scroll.x === 0 && scroll.y === 0) return;
    const deadline = this.now() + SCROLL_RESTORE_MS;
    const expression = `(() => { window.scrollTo(${scroll.x}, ${scroll.y}); return Math.abs(window.scrollY - ${scroll.y}) < 2 && Math.abs(window.scrollX - ${scroll.x}) < 2; })()`;
    for (;;) {
      const result = await this.rawSend("Runtime.evaluate", {
        expression,
        returnByValue: true,
      }).catch(() => null);
      const reached = (result?.result as { value?: unknown } | undefined)?.value === true;
      if (reached || this.now() >= deadline || this.closed) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  public markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.endConsolePause();
    this.screencast.resetLastFrame();
    for (const resolve of this.loadWaiters.splice(0)) resolve();
    this.failDocumentWaiters(new BrowserTabClosedError());
  }

  public dispose(): void {
    // A pick only ends on an answer, a cancel or its client leaving; a tab that closes,
    // loses its target or its browser while the client stays must end it here.
    cancelPick(this.contents);
    this.markClosed();
    this.screencastSize = null;
    this.screencast.close();
    this.video?.close();
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
    const result = await this.navigationSend("Page.navigate", { url });
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
    if (entry) await this.navigationSend("Page.navigateToHistoryEntry", { entryId: entry.id });
  }

  public async reload(): Promise<void> {
    this.touch();
    await this.navigationSend("Page.reload");
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

  /**
   * The text the page has selected: a focused input's or textarea's selection, else the
   * document's. A viewer copies it to its own clipboard; Ctrl+C in the page copies on the host.
   */
  public async readSelection(): Promise<string> {
    this.touch();
    const text = await this.evaluate(SELECTION_SCRIPT);
    return typeof text === "string" ? text : "";
  }

  /** Events read only for the loopback ports: Network, child targets, a child's own session. */
  private handleTraffic(event: CdpEvent): boolean {
    if (event.sessionId !== undefined && event.sessionId !== this.sessionId) {
      // A worker's or frame's session: only its traffic matters here.
      this.loopbackPorts.observe(event);
      return true;
    }
    return this.handleChildTarget(event) || this.loopbackPorts.observe(event);
  }

  private handleChildTarget(event: CdpEvent): boolean {
    if (event.method === "Target.attachedToTarget") {
      const childSession = stringParam(event.params, "sessionId");
      const connection = this.connection;
      if (!childSession || !connection) return true;
      this.childSessions.add(childSession);
      void connection
        .send(
          "Network.enable",
          { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 },
          childSession,
        )
        .catch(() => {});
      return true;
    }
    if (event.method === "Target.detachedFromTarget") {
      const childSession = stringParam(event.params, "sessionId");
      if (childSession) this.childSessions.delete(childSession);
      return true;
    }
    return false;
  }

  /** Every loopback port the page has used since the tab opened, ascending. */
  public observedLoopbackPorts(): number[] {
    return this.loopbackPorts.list();
  }

  /** The toolbar's Stop: ends the load, keeping what the page has shown so far. */
  public async stopLoading(): Promise<void> {
    this.touch();
    await this.send("Page.stopLoading");
  }

  public async setViewport(viewport: ServerBrowserViewport): Promise<void> {
    this.viewport = { ...viewport };
    await this.applyViewport();
    this.video?.refresh();
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
          modifiers: modifierMask(editingModifiers(event, HOST_PLATFORM)),
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
      loadDocument: (url) => this.loadDocument(url),
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

  /**
   * Runs on the document showing now, loading or not. Chromium fails a script still awaiting when
   * its document goes; that failure is reported as the navigation it is.
   */
  private async evaluate(code: string): Promise<unknown> {
    this.touch();
    const documents = this.committedDocuments;
    let result: {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    try {
      result = await this.send("Runtime.evaluate", {
        expression: code,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
    } catch (error) {
      if (this.closed) throw error;
      if (this.committedDocuments !== documents) throw new PageNavigatedError(this.url);
      if (error instanceof Error && LOST_CONTEXT.test(error.message)) {
        // Chromium drops the old document's scripts before it reports the commit.
        await this.waitForCommitAfter(documents);
        throw new PageNavigatedError(this.url);
      }
      throw error;
    }
    if (result.exceptionDetails && this.committedDocuments !== documents) {
      throw new PageNavigatedError(this.url);
    }
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
  /**
   * `untilLoad`: also wait for the load event (at most LOAD_WAIT_MS), for a woken tab whose scroll
   * and video need the page laid out. Otherwise the first page's DOM is enough.
   */
  public async loadFirstPage(url: string, options: { untilLoad?: boolean } = {}): Promise<void> {
    const loaded = options.untilLoad ? this.waitForLoad() : null;
    const document = this.loadDocument(url);
    document.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      document,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FIRST_PAGE_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    await loaded;
    await this.send("Page.resetNavigationHistory");
    await this.refreshHistory();
  }

  /**
   * Settles once the new document's DOM is ready, not at the load event a hanging subresource
   * delays forever.
   */
  private async loadDocument(url: string): Promise<void> {
    this.touch();
    const waiter = this.waitForDocument();
    try {
      const result = await this.navigationSend("Page.navigate", { url });
      const errorText = stringParam(result, "errorText");
      if (errorText === "net::ERR_ABORTED") {
        // Replaced by a newer navigation, whose DOM-ready settles this one; or by nothing.
        if (!this.loading) waiter.settle();
      } else if (errorText) {
        this.setLoadError({ url, errorText });
        throw new Error(`Navigation to ${url} failed: ${errorText}`);
      } else if (stringParam(result, "loaderId") === undefined) {
        // A same-document navigation (a fragment) commits no new document.
        waiter.settle();
      }
      await waiter.promise;
    } finally {
      this.documentWaiters = this.documentWaiters.filter((entry) => entry !== waiter);
    }
    void this.refreshTitle();
  }

  private async waitForPendingDocument(): Promise<void> {
    const deadline = this.now() + PENDING_DOCUMENT_WAIT_MS;
    while (this.documentPending && !this.closed) {
      if (this.now() >= deadline) {
        throw new Error(
          `The tab is still loading its next page (the server has not sent it after ${PENDING_DOCUMENT_WAIT_MS / 1_000} s), and Chromium runs nothing on the page until it arrives. Call browser_wait with url or text to wait for the page, then retry.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async waitForCommitAfter(documents: number): Promise<void> {
    const deadline = this.now() + COMMIT_REPORT_WAIT_MS;
    while (this.committedDocuments === documents && !this.closed && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private waitForDocument(): DocumentWaiter {
    let settle = () => {};
    let fail: (error: Error) => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const waiter: DocumentWaiter = { committed: false, promise, settle, fail };
    this.documentWaiters.push(waiter);
    return waiter;
  }

  private onDomContentLoaded(): void {
    for (const waiter of this.documentWaiters) if (waiter.committed) waiter.settle();
  }

  private failDocumentWaiters(error: Error): void {
    for (const waiter of this.documentWaiters.splice(0)) waiter.fail(error);
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

  private async wake(): Promise<void> {
    await this.onWake();
    if (this.suspension) throw new Error("This tab is suspended and could not be reloaded.");
  }

  /**
   * Navigation commands bypass the tab's queue: Chromium answers them only once the server sends
   * the new document, and scripts and snapshots on the page showing meanwhile must not wait.
   */
  private async navigationSend(method: string, params: CdpParams = {}): Promise<CdpParams> {
    if (this.suspension && !this.closed) await this.wake();
    return this.rawSend(method, params);
  }

  private send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    if (this.suspension && !this.closed) {
      return this.wake().then(() => this.send(method, params));
    }
    if (this.documentPending && PAGE_BOUND_COMMAND.test(method)) {
      // Waits outside the queue: held there, it would hold every later command too.
      return this.waitForPendingDocument().then(() => this.send(method, params));
    }
    if (method.startsWith("Input.")) {
      this.assertNoDialog();
      return this.queue.run(() => this.inputSend(method, params));
    }
    // A clipped or full-page screenshot resizes the view for the capture, and tab capture would
    // show that frame; video pauses around it and viewers resume at a keyframe.
    if (
      this.video &&
      method === "Page.captureScreenshot" &&
      (params.clip || params.captureBeyondViewport)
    ) {
      const video = this.video;
      return video.suspendDuring(() => this.queue.run(() => this.rawSend(method, params)));
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
    const connection = this.connection;
    if (!connection) return;
    const found = (await connection
      .send("Browser.getWindowForTarget", { targetId: this.targetId })
      .catch(() => null)) as { windowId?: number; bounds?: { windowState?: string } } | null;
    if (typeof found?.windowId !== "number" || found.bounds?.windowState !== "minimized") return;
    await connection
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
    const connection = this.connection;
    if (!connection) return Promise.reject(new Error("Browser tab is suspended"));
    if (this.crashed && !CRASH_SAFE_METHODS.has(method)) {
      return Promise.reject(new Error(CRASHED_TAB_MESSAGE));
    }
    return new Promise((resolve, reject) => {
      this.inFlight.add(reject);
      connection
        .send(method, params, this.sessionId)
        .then(resolve, reject)
        .finally(() => this.inFlight.delete(reject));
    });
  }

  /**
   * Chromium keeps a crashed page's target and reports `Inspector.targetCrashed`; nothing else
   * changes, so without this a viewer kept the last frame and an agent's next command hung.
   */
  private onCrashed(): void {
    if (this.crashed) return;
    this.crashed = true;
    this.loading = false;
    this.dialog = null;
    this.fileChooser = null;
    // A crashed renderer sends no more Page events, so a load in progress never settles; without
    // this, commands waited out the loading deadline instead of failing as crashed.
    this.documentPending = false;
    const error = new Error(CRASHED_TAB_MESSAGE);
    for (const reject of Array.from(this.inFlight)) reject(error);
    this.inFlight.clear();
    for (const resolve of this.loadWaiters.splice(0)) resolve();
    this.onChange();
  }

  /** The page reloaded after a crash: its domains and scripts are still set; streams restart. */
  private onRecovered(): void {
    if (!this.crashed) return;
    this.crashed = false;
    this.onChange();
    if (this.screencastSize) this.startScreencast(this.screencastSize);
    this.video?.refresh();
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
    const running = this.screencastSize !== null;
    this.screencastSize = size;
    this.beginWatching();
    // Chrome refuses a start while a screencast runs ("Screencast is already active"), so a new
    // size needs a stop first; Playwright's headless shell restarts instead, which hid this.
    if (running) void this.rawSend("Page.stopScreencast").catch(() => {});
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
    this.endWatching();
    void this.rawSend("Page.stopScreencast").catch(() => {});
  }

  /** A viewer started watching, on either stream. */
  private beginWatching(): void {
    // A viewer wakes a suspended tab; it sees the still frame until the page paints.
    if (this.suspension) {
      void this.onWake().catch(() => {});
      return;
    }
    // A hidden page paints nothing, so a viewer of a minimized window would wait on a blank frame.
    void this.ensureVisible().catch(() => {});
    // A file input asks the viewer instead of opening Chromium's chooser, which no one sees.
    void this.rawSend("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
  }

  /** Called when a stream lost its last viewer; acts only once neither stream has one. */
  private endWatching(): void {
    if (this.viewerCount > 0) return;
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
    this.committedDocuments += 1;
    this.documentPending = false;
    for (const waiter of this.documentWaiters) waiter.committed = true;
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

  /** What the page asks the user (a dialog to answer, files to pick), and its renderer crashing. */
  private handlePageRequest(event: CdpEvent): boolean {
    switch (event.method) {
      case "Inspector.targetCrashed":
        this.onCrashed();
        return true;
      case "Inspector.targetReloadedAfterCrash":
        this.onRecovered();
        return true;
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
    if (this.viewerCount === 0) {
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
    if (typeof backendNodeId !== "number" || this.viewerCount === 0) return;
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

const SELECTION_SCRIPT = `(() => {
  const field = document.activeElement;
  if (field && (field.tagName === "INPUT" || field.tagName === "TEXTAREA") &&
      typeof field.selectionStart === "number" && field.selectionEnd > field.selectionStart) {
    return field.value.slice(field.selectionStart, field.selectionEnd);
  }
  return String(window.getSelection() ?? "");
})()`;

const HOST_PLATFORM = process.platform;
// The editing shortcuts a Mac viewer presses with Cmd, which Chromium off macOS only knows by Ctrl.
const EDITING_CODES = new Set(["KeyA", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyY"]);

/**
 * A Mac viewer's Cmd+A/C/V/X/Z/Y reaches a host that is not a Mac as Meta, which Chromium there
 * ignores; it becomes Ctrl, what that host's Chromium edits with. Shift stays (Cmd+Shift+Z redoes).
 */
export function editingModifiers(
  event: { code: string; modifiers?: Array<keyof typeof MODIFIER_BITS> },
  platform: NodeJS.Platform,
): Array<keyof typeof MODIFIER_BITS> | undefined {
  const modifiers = event.modifiers;
  if (
    platform === "darwin" ||
    !modifiers?.includes("Meta") ||
    modifiers.includes("Control") ||
    modifiers.includes("Alt") ||
    !EDITING_CODES.has(event.code)
  ) {
    return modifiers;
  }
  return modifiers.map((modifier) => (modifier === "Meta" ? "Control" : modifier));
}

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

/** The work's result, or null once `ms` pass or it fails. */
async function withDeadline<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}
