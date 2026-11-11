import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { BrowserAutomationExecuteRequest } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type {
  ServerBrowserStatus,
  ServerBrowserTab as ServerBrowserTabInfo,
} from "@getpaseo/protocol/server-browser/rpc-schemas";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import type { ChromiumExecutableResolution } from "./chromium-executable.js";
import { ServerBrowserUnavailableError, type CdpEvent } from "./cdp-connection.js";
import { TabVideoCapture } from "./tab-video.js";
import {
  executeAutomationCommand,
  type BrowserRegistry,
  type TabContents,
} from "./engine/service.js";
import { BrowserSnapshotEngine } from "./engine/snapshot-engine.js";
import { removeUploads, writeUploads, type UploadedFile } from "./file-uploads.js";
import { stripSnapshotTitle, windowTitleMark, type WindowTitleMark } from "./window-title.js";
import { ServerBrowserTab, type ServerBrowserViewport } from "./server-browser-tab.js";
import {
  SERVER_BROWSER_ENGINE_TRAITS,
  startEngine,
  type DisplayPreference,
  type ServerBrowserEngineConfig,
  type ServerBrowserEngineKind,
} from "./engines.js";
import type {
  ChromiumCookie,
  ChromiumTarget,
  LaunchFn,
  SharedChromium,
} from "./shared-chromium.js";
import {
  originOf,
  withOriginPages,
  WorkspaceStorageStore,
  type LocalStorageItems,
  type WorkspaceStorageState,
} from "./workspace-storage-state.js";

export interface ServerBrowserLimits {
  maxTabs: number;
  /** A workspace with no tabs saves its storage and closes its browser context after this long. */
  contextIdleMs: number;
  /** The shared Chromium exits after this long with no workspace context open. */
  browserIdleMs: number;
  /** A tab no agent command or viewer touched for this long is closed. */
  tabIdleMs: number;
  /** A workspace's storage is saved this long after one of its tabs navigates. */
  saveDelayMs: number;
  /** While a workspace has tabs, its storage is also saved this often (cookies set by fetch). */
  saveIntervalMs: number;
}

export const DEFAULT_SERVER_BROWSER_LIMITS: ServerBrowserLimits = {
  maxTabs: 8,
  contextIdleMs: 3 * 60_000,
  browserIdleMs: 2 * 60_000,
  tabIdleMs: 30 * 60_000,
  saveDelayMs: 2_000,
  saveIntervalMs: 30_000,
};

export interface ServerBrowserHostOptions {
  paseoHome: string;
  logger: Logger;
  isEnabled: () => boolean;
  getConfiguredExecutable?: () => string | null | undefined;
  /** The engine the next browser start uses; Headless (light) when absent. */
  getEngine?: () => ServerBrowserEngineConfig;
  /** Managed Chrome's display; tests pass "xvfb" so no window opens on a real desktop. */
  display?: DisplayPreference;
  resolveExecutable?: () => Promise<ChromiumExecutableResolution>;
  launch?: LaunchFn;
  limits?: Partial<ServerBrowserLimits>;
  /** The workspace's name, for the title mark on an Existing browser's windows. */
  resolveWorkspaceName?: (workspaceId: string) => Promise<string | null>;
  now?: () => number;
}

type TabsListener = (tabs: ServerBrowserTabInfo[], status: ServerBrowserStatus) => void;

export class ServerBrowserLimitError extends Error {
  public constructor(maxTabs: number) {
    super(
      `The server browser already has ${maxTabs} open tabs, its limit. Close tabs you no longer need with browser_close_tab, then try again.`,
    );
    this.name = "ServerBrowserLimitError";
  }
}

interface WorkspaceContext {
  workspaceId: string;
  /** Null when the engine shares the browser's default context across workspaces. */
  browserContextId: string | null;
  chromium: SharedChromium;
  /** Last known localStorage per origin, including origins no tab has open now. */
  origins: Map<string, LocalStorageItems>;
  /** Origins a tab has shown since the last save; their storage may have changed. */
  touchedOrigins: Set<string>;
  lastSaved: string | null;
  saving: Promise<void>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

const SHUTDOWN_SAVE_BUDGET_MS = 5_000;
/** Window keeps the first engines build's file name, so its session cookies carry over. */
function sessionCookiesKey(config: ServerBrowserEngineConfig | null): string {
  return config?.chromeMode === "headless" ? "session-cookies-headless" : "session-cookies";
}

/**
 * The daemon's own browser: one headless Chromium for the whole host, one browser context per
 * workspace (cookies and storage apart, persisted per workspace by `workspace-storage-state.ts`),
 * tabs addressed by browserId, and the vendored desktop automation engine executing MCP browser
 * commands against them.
 */
export class ServerBrowserHost {
  private readonly tabs = new Map<string, ServerBrowserTab>();
  private chromium: Promise<SharedChromium> | null = null;
  private launchedChromium: SharedChromium | null = null;
  /** The tab-capture extension of the running Managed Chrome, loaded on the first video viewer. */
  private tabVideo: { chromium: SharedChromium; capture: Promise<TabVideoCapture> } | null = null;
  private runningEngine: ServerBrowserEngineKind | null = null;
  /** The running engine's whole config; the setting may already name the next one. */
  private runningEngineConfig: ServerBrowserEngineConfig | null = null;
  private readonly contexts = new Map<string, Promise<WorkspaceContext>>();
  private readonly closingContexts = new Map<string, Promise<void>>();
  private readonly clearing = new Set<string>();
  private readonly contextIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private browserIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<TabsListener>();
  private readonly snapshotEngine = new BrowserSnapshotEngine();
  private readonly limits: ServerBrowserLimits;
  private readonly now: () => number;
  private readonly registry: BrowserRegistry;
  private readonly store: WorkspaceStorageStore;
  private readonly managedChromeStore: WorkspaceStorageStore;
  private nextContentsId = 1;
  private noSandbox = false;
  private unavailableReason: string | undefined;
  private notifyScheduled = false;
  private tabSweep: ReturnType<typeof setInterval> | null = null;
  private saveSweep: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  public constructor(private readonly options: ServerBrowserHostOptions) {
    this.limits = { ...DEFAULT_SERVER_BROWSER_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.registry = this.createRegistry();
    this.store = new WorkspaceStorageStore(join(this.rootDir(), "storage"));
    this.managedChromeStore = new WorkspaceStorageStore(join(this.rootDir(), "chrome-session"));
  }

  public isEnabled(): boolean {
    return this.options.isEnabled();
  }

  public status(): ServerBrowserStatus {
    const kind = this.engineConfig().kind;
    return {
      enabled: this.isEnabled(),
      ...(this.unavailableReason ? { unavailableReason: this.unavailableReason } : {}),
      engine: {
        kind,
        sharedStorage: SERVER_BROWSER_ENGINE_TRAITS[kind].isolation === "shared",
      },
    };
  }

  public engineConfig(): ServerBrowserEngineConfig {
    return (
      this.options.getEngine?.() ?? {
        kind: "headless",
        ...(this.options.getConfiguredExecutable?.()
          ? { executablePath: this.options.getConfiguredExecutable()! }
          : {}),
      }
    );
  }

  public listTabs(): ServerBrowserTabInfo[] {
    return [...this.tabs.values()].filter((tab) => !tab.isClosed).map((tab) => tab.info());
  }

  public ownsTab(browserId: string): boolean {
    return this.tabs.has(browserId);
  }

  public getTab(browserId: string): ServerBrowserTab | null {
    const tab = this.tabs.get(browserId);
    return tab && !tab.isClosed ? tab : null;
  }

  /** The shared Chromium's process id, while it runs. */
  public browserPid(): number | undefined {
    return this.launchedChromium?.isAlive ? this.launchedChromium.pid : undefined;
  }

  /** Workspaces whose browser context is open. */
  public openContextIds(): string[] {
    return [...this.contexts.keys()];
  }

  public subscribe(listener: TabsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs one MCP browser command against the server browser. */
  public async execute(
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserToolsResponsePayload> {
    try {
      return await this.executeCommand(request);
    } catch (error) {
      return commandFailure(request.requestId, error);
    }
  }

  private async executeCommand(
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserToolsResponsePayload> {
    if (request.command.command === "new_tab") {
      const workspaceId = request.workspaceId;
      if (!workspaceId) {
        return browserToolsFailure({
          requestId: request.requestId,
          code: "browser_unsupported",
          message: "Cannot create a server browser tab without a workspace context.",
        });
      }
      const url = request.command.args.url ?? "about:blank";
      try {
        const tab = await this.openTab({ workspaceId, url, openedBy: "agent" });
        return {
          requestId: request.requestId,
          ok: true,
          result: {
            command: "new_tab",
            browserId: tab.browserId,
            workspaceId,
            url: tab.currentUrl,
          },
        };
      } catch (error) {
        return commandFailure(request.requestId, error);
      }
    }
    const browserId = "browserId" in request.command.args ? request.command.args.browserId : null;
    if (browserId) this.tabs.get(browserId)?.touch();
    const owned = await this.executeHostCommand(request);
    if (owned) return owned;
    const response = await executeAutomationCommand(request, this.registry, {
      snapshotEngine: this.snapshotEngine,
    });
    // The snapshot's root names the page by its document.title, which carries the window mark.
    const mark = browserId ? this.tabs.get(browserId)?.titleMark : null;
    if (mark && response.ok && response.result.command === "snapshot") {
      response.result.snapshot = stripSnapshotTitle(response.result.snapshot, mark);
    }
    return response;
  }

  private async workspaceName(workspaceId: string): Promise<string | null> {
    try {
      return (await this.options.resolveWorkspaceName?.(workspaceId)) ?? null;
    } catch (error) {
      this.options.logger.warn({ err: error, workspaceId }, "Server browser: no workspace name");
      return null;
    }
  }

  /** The commands the desktop engine leaves to its app runtime; here the host owns the tab. */
  private async executeHostCommand(
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserToolsResponsePayload | null> {
    const { command, requestId } = request;
    if (command.command !== "close_tab" && command.command !== "resize") return null;
    const tab = this.tabs.get(command.args.browserId);
    if (!tab || (request.workspaceId && tab.workspaceId !== request.workspaceId)) {
      return browserToolsFailure({
        requestId,
        code: "browser_tab_not_found",
        message: `No browser tab found for ID: ${command.args.browserId}`,
      });
    }
    if (command.command === "close_tab") {
      await this.closeTab(tab.browserId);
      return { requestId, ok: true, result: { command: "close_tab", browserId: tab.browserId } };
    }
    await tab.setViewport({
      width: command.args.width,
      height: command.args.height,
      mobile: false,
    });
    return {
      requestId,
      ok: true,
      result: {
        command: "resize",
        browserId: tab.browserId,
        width: command.args.width,
        height: command.args.height,
      },
    };
  }

  public async openTab(params: {
    workspaceId: string;
    url: string;
    openedBy: "agent" | "user";
    browserId?: string;
    viewport?: ServerBrowserViewport;
  }): Promise<ServerBrowserTab> {
    if (!this.isEnabled()) throw new Error("The server browser is turned off on this host.");
    if (this.listTabs().length >= this.limits.maxTabs) {
      throw new ServerBrowserLimitError(this.limits.maxTabs);
    }
    assertNavigableUrl(params.url);
    this.cancelContextIdle(params.workspaceId);
    const context = await this.ensureContext(params.workspaceId);
    const titleMark =
      this.runningEngine === "existing"
        ? windowTitleMark(await this.workspaceName(params.workspaceId))
        : null;
    const target = await context.chromium.createTarget(context.browserContextId ?? undefined);
    const tab = this.addTab({
      browserId: params.browserId ?? randomUUID(),
      workspaceId: params.workspaceId,
      target,
      openedBy: params.openedBy,
      ...(params.viewport ? { viewport: params.viewport } : {}),
      ...(titleMark ? { titleMark } : {}),
    });
    try {
      await tab.initialize();
      if (params.url !== "about:blank") await tab.loadFirstPage(params.url);
    } catch (error) {
      this.options.logger.warn({ err: error, url: params.url }, "Server browser tab load failed");
    }
    this.scheduleNotify();
    return tab;
  }

  private addTab(params: {
    browserId: string;
    workspaceId: string;
    target: ChromiumTarget;
    openedBy: "agent" | "user";
    viewport?: ServerBrowserViewport;
    titleMark?: WindowTitleMark;
    openerBrowserId?: string;
  }): ServerBrowserTab {
    const { target, workspaceId } = params;
    const tab = new ServerBrowserTab({
      browserId: params.browserId,
      workspaceId,
      contentsId: this.nextContentsId++,
      targetId: target.targetId,
      sessionId: target.sessionId,
      connection: target.connection,
      openedBy: params.openedBy,
      ...(params.viewport ? { viewport: params.viewport } : {}),
      ...(params.titleMark ? { titleMark: params.titleMark } : {}),
      ...(params.openerBrowserId ? { openerBrowserId: params.openerBrowserId } : {}),
      onChange: () => this.scheduleNotify(),
      onNavigated: (url) => void this.onTabNavigated(workspaceId, url),
      videoCapture: () => this.videoCapture(),
      onVideoError: (message) =>
        this.options.logger.warn({ message }, "Server browser video failed; back to JPEG"),
      onVideoPlan: (encodes) =>
        this.options.logger.debug(
          { browserId: params.browserId, encodes },
          "Server browser video encodes",
        ),
      now: this.now,
    });
    this.tabs.set(tab.browserId, tab);
    this.cancelContextIdle(workspaceId);
    this.ensureSweeps();
    return tab;
  }

  /**
   * A page one of our tabs opened (window.open, a target=_blank link) becomes a tab of the same
   * workspace, at its opener's size, so clients can show it. Past the tab limit it is closed.
   */
  private async adoptPopup(popup: { targetId: string; openerId: string }): Promise<void> {
    const opener = this.findTabByTarget(popup.openerId);
    const chromium = this.launchedChromium;
    if (!opener || !chromium?.isAlive) return;
    if (this.listTabs().length >= this.limits.maxTabs) {
      await chromium.closeTarget(popup.targetId);
      opener.warn(
        `A popup was closed: the server browser already has ${this.limits.maxTabs} open tabs.`,
      );
      return;
    }
    try {
      const target = await chromium.attachTarget(popup.targetId);
      const tab = this.addTab({
        browserId: randomUUID(),
        workspaceId: opener.workspaceId,
        target,
        openedBy: opener.openedBy,
        viewport: opener.currentViewport,
        ...(opener.titleMark ? { titleMark: opener.titleMark } : {}),
        openerBrowserId: opener.browserId,
      });
      await tab.initialize();
      const { targetInfo } = (await target.connection.send("Target.getTargetInfo", {
        targetId: popup.targetId,
      })) as { targetInfo: { url: string; title: string } };
      tab.updateTargetInfo(targetInfo);
    } catch (error) {
      this.options.logger.warn({ err: error }, "Server browser: popup not adopted");
    }
    this.scheduleNotify();
  }

  /** A viewer's files for a tab's file chooser: written on this host, then set on the input. */
  public async answerFileChooser(
    browserId: string,
    chooserId: string,
    files: readonly UploadedFile[],
  ): Promise<void> {
    const tab = this.getTab(browserId);
    if (!tab) throw new Error(`No server browser tab ${browserId}`);
    const paths = files.length > 0 ? await writeUploads(this.uploadsDir(), browserId, files) : [];
    await tab.answerFileChooser(chooserId, paths);
  }

  private uploadsDir(): string {
    return join(this.rootDir(), "uploads");
  }

  public async closeTab(browserId: string): Promise<void> {
    const tab = this.tabs.get(browserId);
    if (!tab) return;
    this.tabs.delete(browserId);
    tab.dispose();
    const chromium = this.launchedChromium;
    // Headed Chrome left without a window can quit on its own; keep its session cookies first.
    if (chromium?.isAlive && this.runningEngine === "managed-chrome" && this.tabs.size === 0) {
      await this.saveSessionCookies(chromium);
    }
    if (chromium?.isAlive) await chromium.closeTarget(tab.cdpTargetId);
    void removeUploads(this.uploadsDir(), browserId).catch(() => {});
    this.afterTabRemoved(tab.workspaceId);
  }

  /** Wipes a workspace's storage; open tabs come back at their URLs with the same browserIds. */
  public async clearWorkspaceData(workspaceId: string): Promise<void> {
    if (this.isolationOfRunningEngine() === "shared") {
      throw new Error(
        "This engine keeps one browser profile for every workspace, so there is no workspace data to clear. Sign out in the page, or clear data in that browser.",
      );
    }
    const reopen = [...this.tabs.values()]
      .filter((tab) => tab.workspaceId === workspaceId)
      .map((tab) => ({ url: tab.currentUrl, tab }));
    this.clearing.add(workspaceId);
    try {
      for (const entry of reopen) entry.tab.markClosed();
      await this.closeContext(workspaceId, { save: false });
      await this.store.remove(workspaceId);
      if (reopen.length === 0) return;
      const context = await this.ensureContext(workspaceId);
      for (const entry of reopen) {
        const target = await context.chromium.createTarget(context.browserContextId ?? undefined);
        entry.tab.rebind(target);
        await entry.tab.initialize();
        if (/^https?:/.test(entry.url)) await entry.tab.loadFirstPage(entry.url).catch(() => {});
      }
    } finally {
      this.clearing.delete(workspaceId);
      this.scheduleNotify();
    }
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopSweeps();
    await this.closeEverything();
    await rm(this.uploadsDir(), { recursive: true, force: true }).catch(() => {});
    this.listeners.clear();
  }

  /** The switch went off: save storage, close everything, tell viewers. */
  public async disable(): Promise<void> {
    await this.closeEverything();
    this.scheduleNotify();
  }

  public notifyStatusChanged(): void {
    this.scheduleNotify();
  }

  /** Saves the workspace's cookies and localStorage now. Skips the write when nothing changed. */
  public saveWorkspaceStorage(workspaceId: string): Promise<void> {
    const pending = this.contexts.get(workspaceId);
    if (!pending) return Promise.resolve();
    return pending.then(
      (context) => this.saveContext(context),
      () => {},
    );
  }

  private async closeEverything(): Promise<void> {
    for (const tab of this.tabs.values()) tab.dispose();
    this.tabs.clear();
    for (const timer of this.contextIdleTimers.values()) clearTimeout(timer);
    this.contextIdleTimers.clear();
    // Saving needs the browser; give it a bounded time so a wedged page cannot stall shutdown.
    await withTimeout(
      Promise.all(
        [...this.contexts.keys()].map((workspaceId) =>
          this.closeContext(workspaceId, { save: true }),
        ),
      ),
      SHUTDOWN_SAVE_BUDGET_MS,
    );
    await this.closeChromium();
  }

  private async ensureContext(workspaceId: string): Promise<WorkspaceContext> {
    const existing = this.contexts.get(workspaceId);
    if (existing) {
      const context = await existing.catch(() => null);
      if (context && !context.disposed && context.chromium.isAlive) return context;
      if (this.contexts.get(workspaceId) === existing) this.contexts.delete(workspaceId);
    }
    const creating = this.createContext(workspaceId);
    this.contexts.set(workspaceId, creating);
    creating.catch(() => {
      if (this.contexts.get(workspaceId) === creating) this.contexts.delete(workspaceId);
    });
    return creating;
  }

  private async createContext(workspaceId: string): Promise<WorkspaceContext> {
    // A context still saving on its way out must finish before this one reads the file.
    await this.closingContexts.get(workspaceId);
    const chromium = await this.ensureChromium();
    this.cancelBrowserIdle();
    const isolated = this.isolationOfRunningEngine() === "context";
    const browserContextId = isolated ? await chromium.createContext() : null;
    const context: WorkspaceContext = {
      workspaceId,
      browserContextId,
      chromium,
      origins: new Map(),
      touchedOrigins: new Set(),
      lastSaved: null,
      saving: Promise.resolve(),
      saveTimer: null,
      disposed: false,
    };
    if (!browserContextId) return context;
    const state = await this.store.load(workspaceId);
    if (state) await this.restoreContext(context, browserContextId, state);
    return context;
  }

  private async restoreContext(
    context: WorkspaceContext,
    browserContextId: string,
    state: WorkspaceStorageState,
  ): Promise<void> {
    const { chromium, workspaceId } = context;
    await chromium.setCookies(browserContextId, state.cookies).catch((error) => {
      this.options.logger.warn({ err: error, workspaceId }, "Server browser: cookies not restored");
    });
    const origins = Object.entries(state.origins).filter(([, items]) => items.length > 0);
    for (const [origin, items] of origins) context.origins.set(origin, items);
    if (origins.length > 0) {
      await withOriginPages({
        chromium,
        browserContextId,
        run: async (page) => {
          for (const [origin, items] of origins) {
            await page.open(origin);
            await page.writeLocalStorage(items);
          }
        },
      }).catch((error) => {
        this.options.logger.warn(
          { err: error, workspaceId },
          "Server browser: localStorage not restored",
        );
      });
    }
    context.lastSaved = serializeState(context, state.cookies);
  }

  private saveContext(context: WorkspaceContext): Promise<void> {
    if (context.saveTimer) clearTimeout(context.saveTimer);
    context.saveTimer = null;
    // One save at a time per workspace; a later one reads what the earlier one left.
    context.saving = context.saving.then(() =>
      this.writeContext(context).catch((error) => {
        this.options.logger.warn(
          { err: error, workspaceId: context.workspaceId },
          "Server browser: storage not saved",
        );
      }),
    );
    return context.saving;
  }

  private async writeContext(context: WorkspaceContext): Promise<void> {
    const { chromium, browserContextId } = context;
    // A shared default context belongs to the browser's own profile, which persists itself.
    if (context.disposed || !chromium.isAlive || !browserContextId) return;
    const cookies = await chromium.getCookies(browserContextId);
    const tabs = [...this.tabs.values()].filter(
      (tab) => tab.workspaceId === context.workspaceId && !tab.isClosed,
    );
    const read = new Set<string>();
    const stillOpen = new Set<string>();
    for (const tab of tabs) {
      const origin = originOf(tab.currentUrl);
      if (origin) stillOpen.add(origin);
      const storage = await tab.readLocalStorage();
      if (!storage) continue;
      read.add(storage.origin);
      setOrigin(context, storage.origin, storage.items);
    }
    // An origin a tab left since the last save, or whose tab was too busy to answer: a hidden
    // page reads it. One that fails keeps its last snapshot and is tried again next save.
    const unread = new Set([...context.touchedOrigins, ...stillOpen].filter((o) => !read.has(o)));
    if (unread.size > 0) {
      await withOriginPages({
        chromium,
        browserContextId,
        run: async (page) => {
          for (const origin of unread) {
            try {
              await page.open(origin);
              setOrigin(context, origin, await page.readLocalStorage());
              unread.delete(origin);
            } catch {}
          }
        },
      }).catch(() => {});
    }
    context.touchedOrigins = new Set([...stillOpen, ...unread]);
    const serialized = serializeState(context, cookies);
    if (serialized === context.lastSaved) return;
    await this.store.save(context.workspaceId, serialized);
    context.lastSaved = serialized;
  }

  private scheduleSave(context: WorkspaceContext): void {
    if (context.saveTimer) clearTimeout(context.saveTimer);
    context.saveTimer = setTimeout(() => {
      context.saveTimer = null;
      void this.saveContext(context);
    }, this.limits.saveDelayMs);
    context.saveTimer.unref?.();
  }

  /** Saves (unless the data is being cleared) and disposes a workspace's context. */
  private closeContext(workspaceId: string, options: { save: boolean }): Promise<void> {
    this.cancelContextIdle(workspaceId);
    const pending = this.contexts.get(workspaceId);
    if (!pending) return this.closingContexts.get(workspaceId) ?? Promise.resolve();
    this.contexts.delete(workspaceId);
    const closing = (async () => {
      const context = await pending.catch(() => null);
      if (!context) return;
      if (options.save) await this.saveContext(context);
      else await context.saving;
      context.disposed = true;
      if (context.saveTimer) clearTimeout(context.saveTimer);
      if (context.browserContextId) {
        await context.chromium.disposeContext(context.browserContextId);
      }
    })().finally(() => {
      if (this.closingContexts.get(workspaceId) === closing) {
        this.closingContexts.delete(workspaceId);
      }
      if (this.contexts.size === 0 && !this.shuttingDown) this.scheduleBrowserIdle();
    });
    this.closingContexts.set(workspaceId, closing);
    return closing;
  }

  private async ensureChromium(): Promise<SharedChromium> {
    const existing = this.chromium;
    if (existing) {
      const chromium = await existing.catch(() => null);
      if (chromium?.isAlive) return chromium;
      if (this.chromium === existing) this.chromium = null;
    }
    const launching = this.launchChromium();
    this.chromium = launching;
    launching.catch(() => {
      if (this.chromium === launching) this.chromium = null;
    });
    return launching;
  }

  private async launchChromium(): Promise<SharedChromium> {
    const config = this.engineConfig();
    const startedAt = this.now();
    let started: SharedChromium | null = null;
    try {
      started = await startEngine({
        config,
        paseoHome: this.options.paseoHome,
        noSandbox: this.noSandbox,
        ...(this.options.launch ? { launch: this.options.launch } : {}),
        ...(this.options.resolveExecutable
          ? { resolveExecutable: this.options.resolveExecutable }
          : {}),
        ...(this.options.display ? { display: this.options.display } : {}),
        onWarning: (message) => this.options.logger.warn(`Server browser: ${message}`),
        events: {
          onEvent: (event) => this.routeEvent(event),
          onTargetInfo: (info) => this.findTabByTarget(info.targetId)?.updateTargetInfo(info),
          onTargetDestroyed: (targetId) => this.onTargetDestroyed(targetId),
          onPopup: (popup) => void this.adoptPopup(popup),
          onExit: () => this.onChromiumExit(started),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.unavailableReason =
        config.kind === "existing" ? message : `Chromium failed to start: ${message}`;
      this.scheduleNotify();
      throw error;
    }
    const chromium = started;
    if (config.kind === "managed-chrome") await this.restoreSessionCookies(chromium, config);
    if (chromium.isOwned && !chromium.sandboxed && !this.noSandbox) {
      this.noSandbox = true;
      this.options.logger.warn(
        "Server browser: Chromium has no usable sandbox on this host; running it with --no-sandbox",
      );
    }
    this.unavailableReason = undefined;
    this.launchedChromium = chromium;
    this.runningEngine = config.kind;
    this.runningEngineConfig = config;
    this.options.logger.info(
      { engine: config.kind, pid: chromium.pid, ms: this.now() - startedAt },
      "Server browser started",
    );
    return chromium;
  }

  /** The isolation of the browser that runs now, or of the one the next start brings. */
  private isolationOfRunningEngine(): "context" | "shared" {
    const kind = this.launchedChromium?.isAlive ? this.runningEngine : this.engineConfig().kind;
    return SERVER_BROWSER_ENGINE_TRAITS[kind ?? "headless"].isolation;
  }

  private async closeChromium(): Promise<void> {
    this.cancelBrowserIdle();
    const pending = this.chromium;
    this.chromium = null;
    const chromium = await pending?.catch(() => null);
    if (chromium && this.runningEngine === "managed-chrome")
      await this.saveSessionCookies(chromium);
    await chromium?.close();
  }

  /**
   * Managed Chrome keeps its own profile, but a session cookie (no expiry) ends with the browser
   * session, as in any Chrome. A person's Chrome runs for days; Paseo's exits when idle, which
   * would sign dev apps with session-cookie logins out every few minutes. Session cookies are
   * carried across Paseo's own restarts of it; everything else stays Chrome's.
   */
  private async saveSessionCookies(chromium: SharedChromium): Promise<void> {
    if (!chromium.isAlive) return;
    try {
      const cookies = await chromium.getCookies(null, { sessionOnly: true });
      const state: WorkspaceStorageState = { version: 1, cookies, origins: {} };
      const key = sessionCookiesKey(this.runningEngineConfig);
      await this.managedChromeStore.save(key, JSON.stringify(state));
    } catch (error) {
      this.options.logger.warn({ err: error }, "Server browser: session cookies not saved");
    }
  }

  private async restoreSessionCookies(
    chromium: SharedChromium,
    config: ServerBrowserEngineConfig,
  ): Promise<void> {
    const state = await this.managedChromeStore.load(sessionCookiesKey(config));
    if (!state) return;
    await chromium.setCookies(null, state.cookies).catch((error) => {
      this.options.logger.warn({ err: error }, "Server browser: session cookies not restored");
    });
  }

  private routeEvent(event: CdpEvent): void {
    for (const tab of this.tabs.values()) {
      if (tab.owns(event.sessionId)) {
        tab.handleEvent(event);
        return;
      }
    }
  }

  private findTabByTarget(targetId: string): ServerBrowserTab | undefined {
    for (const tab of this.tabs.values()) if (tab.cdpTargetId === targetId) return tab;
    return undefined;
  }

  private async onTabNavigated(workspaceId: string, url: string): Promise<void> {
    const origin = originOf(url);
    const context = origin ? await this.contexts.get(workspaceId)?.catch(() => null) : null;
    if (!origin || !context) return;
    context.touchedOrigins.add(origin);
    this.scheduleSave(context);
  }

  private onTargetDestroyed(targetId: string): void {
    const tab = this.findTabByTarget(targetId);
    // Clearing data disposes the context; the tabs come back under the same ids.
    if (!tab || this.clearing.has(tab.workspaceId)) return;
    this.tabs.delete(tab.browserId);
    tab.dispose();
    void removeUploads(this.uploadsDir(), tab.browserId).catch(() => {});
    this.afterTabRemoved(tab.workspaceId);
  }

  private onChromiumExit(chromium: SharedChromium | null): void {
    if (chromium && this.launchedChromium === chromium) this.launchedChromium = null;
    if (this.shuttingDown) return;
    // Every context died with the process; their storage is what the last save wrote. A pending
    // save timer finds its browser gone and writes nothing.
    this.contexts.clear();
    const tabs = [...this.tabs.values()].filter((tab) => !this.clearing.has(tab.workspaceId));
    for (const tab of tabs) {
      this.tabs.delete(tab.browserId);
      tab.dispose();
    }
    for (const timer of this.contextIdleTimers.values()) clearTimeout(timer);
    this.contextIdleTimers.clear();
    if (tabs.length > 0) {
      this.options.logger.warn({ tabs: tabs.length }, "Server browser exited with open tabs");
      this.scheduleNotify();
    }
  }

  private afterTabRemoved(workspaceId: string): void {
    this.scheduleNotify();
    const remaining = [...this.tabs.values()].some((tab) => tab.workspaceId === workspaceId);
    if (!remaining && this.contexts.has(workspaceId)) this.scheduleContextIdle(workspaceId);
  }

  private scheduleContextIdle(workspaceId: string): void {
    this.cancelContextIdle(workspaceId);
    const timer = setTimeout(() => {
      this.contextIdleTimers.delete(workspaceId);
      if ([...this.tabs.values()].some((tab) => tab.workspaceId === workspaceId)) return;
      void this.closeContext(workspaceId, { save: true });
    }, this.limits.contextIdleMs);
    timer.unref?.();
    this.contextIdleTimers.set(workspaceId, timer);
  }

  private cancelContextIdle(workspaceId: string): void {
    const timer = this.contextIdleTimers.get(workspaceId);
    if (timer) clearTimeout(timer);
    this.contextIdleTimers.delete(workspaceId);
  }

  private scheduleBrowserIdle(): void {
    this.cancelBrowserIdle();
    this.browserIdleTimer = setTimeout(() => {
      this.browserIdleTimer = null;
      if (this.contexts.size > 0 || this.closingContexts.size > 0) return;
      void this.closeChromium();
    }, this.limits.browserIdleMs);
    this.browserIdleTimer.unref?.();
  }

  private cancelBrowserIdle(): void {
    if (this.browserIdleTimer) clearTimeout(this.browserIdleTimer);
    this.browserIdleTimer = null;
  }

  private ensureSweeps(): void {
    if (!this.tabSweep) {
      this.tabSweep = setInterval(
        () => this.sweepIdleTabs(),
        Math.min(60_000, this.limits.tabIdleMs),
      );
      this.tabSweep.unref?.();
    }
    if (!this.saveSweep) {
      this.saveSweep = setInterval(() => this.saveWorkspacesWithTabs(), this.limits.saveIntervalMs);
      this.saveSweep.unref?.();
    }
  }

  private stopSweeps(): void {
    if (this.tabSweep) clearInterval(this.tabSweep);
    if (this.saveSweep) clearInterval(this.saveSweep);
    this.tabSweep = null;
    this.saveSweep = null;
  }

  public sweepIdleTabs(): void {
    const cutoff = this.now() - this.limits.tabIdleMs;
    for (const tab of this.tabs.values()) {
      if (tab.viewerCount > 0) tab.touch();
      else if (tab.lastUsedAt < cutoff) void this.closeTab(tab.browserId);
    }
  }

  private saveWorkspacesWithTabs(): void {
    const workspaces = new Set([...this.tabs.values()].map((tab) => tab.workspaceId));
    for (const workspaceId of workspaces) void this.saveWorkspaceStorage(workspaceId);
    const chromium = this.launchedChromium;
    if (chromium && this.runningEngine === "managed-chrome" && this.tabs.size > 0) {
      void this.saveSessionCookies(chromium);
    }
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    setTimeout(() => {
      this.notifyScheduled = false;
      const tabs = this.listTabs();
      const status = this.status();
      for (const listener of this.listeners) listener(tabs, status);
    }, 50);
  }

  /** Null on engines without tab capture: Headless (light) and Existing browser. */
  private async videoCapture(): Promise<TabVideoCapture | null> {
    const chromium = this.launchedChromium;
    if (!chromium?.isAlive || this.runningEngine !== "managed-chrome") return null;
    if (this.tabVideo?.chromium !== chromium) {
      const capture = TabVideoCapture.load(
        chromium.cdp,
        join(this.rootDir(), "tab-video-extension"),
      );
      capture.catch((error: unknown) =>
        this.options.logger.warn({ err: error }, "Server browser tab video unavailable"),
      );
      this.tabVideo = { chromium, capture };
    }
    return this.tabVideo.capture;
  }

  private rootDir(): string {
    return join(this.options.paseoHome, "server-browser");
  }

  private createRegistry(): BrowserRegistry {
    const live = () => [...this.tabs.values()].filter((tab) => !tab.isClosed);
    return {
      listRegisteredBrowserIds: () => live().map((tab) => tab.browserId),
      listRegisteredBrowserIdsForWorkspace: (workspaceId) =>
        live()
          .filter((tab) => tab.workspaceId === workspaceId)
          .map((tab) => tab.browserId),
      getTabContents: (browserId): TabContents | null => this.tabs.get(browserId)?.contents ?? null,
      getBrowserWorkspaceId: (browserId) => this.tabs.get(browserId)?.workspaceId ?? null,
      getWorkspaceActiveBrowserId: (workspaceId) => {
        const tabs = live().filter((tab) => tab.workspaceId === workspaceId);
        tabs.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        return tabs[0]?.browserId ?? null;
      },
    };
  }
}

function setOrigin(context: WorkspaceContext, origin: string, items: LocalStorageItems): void {
  if (items.length > 0) context.origins.set(origin, items);
  else context.origins.delete(origin);
}

function serializeState(context: WorkspaceContext, cookies: ChromiumCookie[]): string {
  const state: WorkspaceStorageState = {
    version: 1,
    cookies,
    origins: Object.fromEntries(context.origins),
  };
  return JSON.stringify(state);
}

async function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

export function assertNavigableUrl(url: string): void {
  if (url === "about:blank") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The server browser only opens http and https URLs.");
  }
}

/**
 * A command's error as the agent sees it. A browser that is not there (closed, not running,
 * nothing at the Existing browser's address) is retryable under the code the broker uses for an
 * unreachable browser host: the next tab starts or reattaches it.
 */
function commandFailure(requestId: string, error: unknown): BrowserToolsResponsePayload {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ServerBrowserLimitError) {
    return browserToolsFailure({ requestId, code: "browser_denied", message });
  }
  if (error instanceof ServerBrowserUnavailableError) {
    return browserToolsFailure({ requestId, code: "browser_no_host", message, retryable: true });
  }
  return browserToolsFailure({ requestId, code: "browser_unknown_error", message });
}
