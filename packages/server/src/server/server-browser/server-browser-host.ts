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
import {
  resolveChromiumExecutable,
  type ChromiumExecutableResolution,
} from "./chromium-executable.js";
import type { CdpEvent } from "./cdp-connection.js";
import {
  executeAutomationCommand,
  type BrowserRegistry,
  type TabContents,
} from "./engine/service.js";
import { BrowserSnapshotEngine } from "./engine/snapshot-engine.js";
import { ServerBrowserTab, type ServerBrowserViewport } from "./server-browser-tab.js";
import { WorkspaceBrowser, type LaunchFn } from "./workspace-browser.js";

export interface ServerBrowserLimits {
  maxTabs: number;
  /** A workspace browser with no tabs exits after this long. */
  browserIdleMs: number;
  /** A tab no agent command or viewer touched for this long is closed. */
  tabIdleMs: number;
}

export const DEFAULT_SERVER_BROWSER_LIMITS: ServerBrowserLimits = {
  maxTabs: 8,
  browserIdleMs: 10 * 60_000,
  tabIdleMs: 2 * 60 * 60_000,
};

export interface ServerBrowserHostOptions {
  paseoHome: string;
  logger: Logger;
  isEnabled: () => boolean;
  getConfiguredExecutable?: () => string | null | undefined;
  resolveExecutable?: () => Promise<ChromiumExecutableResolution>;
  launch?: LaunchFn;
  limits?: Partial<ServerBrowserLimits>;
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

/**
 * The daemon's own browser: headless Chromium per workspace, tabs addressed by browserId, and the
 * vendored desktop automation engine executing MCP browser commands against them.
 */
export class ServerBrowserHost {
  private readonly tabs = new Map<string, ServerBrowserTab>();
  private readonly browsers = new Map<string, Promise<WorkspaceBrowser>>();
  private readonly relaunching = new Set<string>();
  private readonly launchedBrowsers = new Map<string, WorkspaceBrowser>();
  private readonly browserIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<TabsListener>();
  private readonly snapshotEngine = new BrowserSnapshotEngine();
  private readonly limits: ServerBrowserLimits;
  private readonly now: () => number;
  private readonly registry: BrowserRegistry;
  private nextContentsId = 1;
  private noSandbox = false;
  private unavailableReason: string | undefined;
  private notifyScheduled = false;
  private tabSweep: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  public constructor(private readonly options: ServerBrowserHostOptions) {
    this.limits = { ...DEFAULT_SERVER_BROWSER_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.registry = this.createRegistry();
  }

  public isEnabled(): boolean {
    return this.options.isEnabled();
  }

  public status(): ServerBrowserStatus {
    return {
      enabled: this.isEnabled(),
      ...(this.unavailableReason ? { unavailableReason: this.unavailableReason } : {}),
    };
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

  /** The workspace's Chromium process id, while one runs. */
  public browserPid(workspaceId: string): number | undefined {
    return this.launchedBrowsers.get(workspaceId)?.pid;
  }

  public subscribe(listener: TabsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs one MCP browser command against the server browser. */
  public async execute(
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
        return browserToolsFailure({
          requestId: request.requestId,
          code:
            error instanceof ServerBrowserLimitError ? "browser_denied" : "browser_unknown_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const browserId = "browserId" in request.command.args ? request.command.args.browserId : null;
    if (browserId) this.tabs.get(browserId)?.touch();
    const owned = await this.executeHostCommand(request);
    if (owned) return owned;
    return executeAutomationCommand(request, this.registry, {
      snapshotEngine: this.snapshotEngine,
    });
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
    const browser = await this.ensureBrowser(params.workspaceId);
    const target = await browser.createTarget();
    const tab = new ServerBrowserTab({
      browserId: params.browserId ?? randomUUID(),
      workspaceId: params.workspaceId,
      contentsId: this.nextContentsId++,
      targetId: target.targetId,
      sessionId: target.sessionId,
      connection: target.connection,
      openedBy: params.openedBy,
      ...(params.viewport ? { viewport: params.viewport } : {}),
      onChange: () => this.scheduleNotify(),
      now: this.now,
    });
    this.tabs.set(tab.browserId, tab);
    this.cancelBrowserIdle(params.workspaceId);
    this.ensureTabSweep();
    try {
      await tab.initialize();
      if (params.url !== "about:blank") await tab.contents.loadURL(params.url);
    } catch (error) {
      this.options.logger.warn({ err: error, url: params.url }, "Server browser tab load failed");
    }
    this.scheduleNotify();
    return tab;
  }

  public async closeTab(browserId: string): Promise<void> {
    const tab = this.tabs.get(browserId);
    if (!tab) return;
    this.tabs.delete(browserId);
    tab.dispose();
    const browser = await this.browsers.get(tab.workspaceId)?.catch(() => null);
    await browser?.closeTarget(tab.cdpTargetId);
    this.afterTabRemoved(tab.workspaceId);
  }

  /** Wipes a workspace's profile; open tabs come back at their URLs with the same browserIds. */
  public async clearWorkspaceData(workspaceId: string): Promise<void> {
    const reopen = [...this.tabs.values()]
      .filter((tab) => tab.workspaceId === workspaceId)
      .map((tab) => ({ url: tab.currentUrl, tab }));
    this.relaunching.add(workspaceId);
    try {
      await this.closeBrowser(workspaceId);
      await rm(this.profileDir(workspaceId), { recursive: true, force: true });
      if (reopen.length === 0) return;
      const browser = await this.ensureBrowser(workspaceId);
      for (const entry of reopen) {
        const target = await browser.createTarget();
        entry.tab.rebind(target);
        await entry.tab.initialize();
        if (/^https?:/.test(entry.url)) await entry.tab.navigate(entry.url).catch(() => {});
      }
    } finally {
      this.relaunching.delete(workspaceId);
      this.scheduleNotify();
    }
  }

  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.tabSweep) clearInterval(this.tabSweep);
    this.tabSweep = null;
    for (const timer of this.browserIdleTimers.values()) clearTimeout(timer);
    this.browserIdleTimers.clear();
    for (const tab of this.tabs.values()) tab.dispose();
    this.tabs.clear();
    await Promise.all(
      [...this.browsers.keys()].map((workspaceId) => this.closeBrowser(workspaceId)),
    );
    this.listeners.clear();
  }

  /** The switch went off: close everything, tell viewers. */
  public async disable(): Promise<void> {
    for (const tab of this.tabs.values()) tab.dispose();
    this.tabs.clear();
    await Promise.all(
      [...this.browsers.keys()].map((workspaceId) => this.closeBrowser(workspaceId)),
    );
    this.scheduleNotify();
  }

  public notifyStatusChanged(): void {
    this.scheduleNotify();
  }

  private async ensureBrowser(workspaceId: string): Promise<WorkspaceBrowser> {
    const existing = this.browsers.get(workspaceId);
    if (existing) {
      const browser = await existing.catch(() => null);
      if (browser?.isAlive) return browser;
      if (this.browsers.get(workspaceId) === existing) this.browsers.delete(workspaceId);
    }
    const launching = this.launchBrowser(workspaceId);
    this.browsers.set(workspaceId, launching);
    launching.catch(() => {
      if (this.browsers.get(workspaceId) === launching) this.browsers.delete(workspaceId);
    });
    return launching;
  }

  private async launchBrowser(workspaceId: string): Promise<WorkspaceBrowser> {
    const resolution = this.options.resolveExecutable
      ? await this.options.resolveExecutable()
      : await resolveChromiumExecutable({
          configuredPath: this.options.getConfiguredExecutable?.(),
        });
    if (!resolution.ok) {
      this.unavailableReason = resolution.message;
      this.scheduleNotify();
      throw new Error(resolution.message);
    }
    const startedAt = this.now();
    try {
      const browser = await WorkspaceBrowser.launch({
        workspaceId,
        executablePath: resolution.path,
        userDataDir: this.profileDir(workspaceId),
        noSandbox: this.noSandbox,
        ...(this.options.launch ? { launch: this.options.launch } : {}),
        events: {
          onEvent: (event) => this.routeEvent(event),
          onTargetInfo: (info) => this.findTabByTarget(info.targetId)?.updateTargetInfo(info),
          onTargetDestroyed: (targetId) => this.onTargetDestroyed(targetId),
          onExit: () => this.onBrowserExit(workspaceId),
        },
      });
      if (!browser.sandboxed && !this.noSandbox) {
        this.noSandbox = true;
        this.options.logger.warn(
          "Server browser: Chromium has no usable sandbox on this host; running it with --no-sandbox",
        );
      }
      this.unavailableReason = undefined;
      this.launchedBrowsers.set(workspaceId, browser);
      this.options.logger.info(
        { workspaceId, pid: browser.pid, executable: resolution.path, ms: this.now() - startedAt },
        "Server browser started",
      );
      return browser;
    } catch (error) {
      this.unavailableReason = `Chromium failed to start: ${error instanceof Error ? error.message : String(error)}`;
      this.scheduleNotify();
      throw error;
    }
  }

  private async closeBrowser(workspaceId: string): Promise<void> {
    this.cancelBrowserIdle(workspaceId);
    const pending = this.browsers.get(workspaceId);
    this.browsers.delete(workspaceId);
    const browser = await pending?.catch(() => null);
    await browser?.close();
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

  private onTargetDestroyed(targetId: string): void {
    const tab = this.findTabByTarget(targetId);
    // A relaunch for cleared data destroys every target; the tabs come back under the same ids.
    if (!tab || this.relaunching.has(tab.workspaceId)) return;
    this.tabs.delete(tab.browserId);
    tab.dispose();
    this.afterTabRemoved(tab.workspaceId);
  }

  private onBrowserExit(workspaceId: string): void {
    if (this.launchedBrowsers.get(workspaceId)?.isAlive === false) {
      this.launchedBrowsers.delete(workspaceId);
    }
    if (this.shuttingDown) return;
    const tabs = [...this.tabs.values()].filter((tab) => tab.workspaceId === workspaceId);
    for (const tab of tabs) tab.markClosed();
    // Clearing data relaunches the browser and rebinds these tabs; a crash or close ends them.
    if (this.relaunching.has(workspaceId)) return;
    for (const tab of tabs) {
      this.tabs.delete(tab.browserId);
      tab.dispose();
    }
    if (tabs.length > 0) {
      this.options.logger.warn(
        { workspaceId, tabs: tabs.length },
        "Server browser exited with open tabs",
      );
      this.scheduleNotify();
    }
  }

  private afterTabRemoved(workspaceId: string): void {
    this.scheduleNotify();
    const remaining = [...this.tabs.values()].some((tab) => tab.workspaceId === workspaceId);
    if (!remaining) this.scheduleBrowserIdle(workspaceId);
  }

  private scheduleBrowserIdle(workspaceId: string): void {
    this.cancelBrowserIdle(workspaceId);
    const timer = setTimeout(() => {
      this.browserIdleTimers.delete(workspaceId);
      if ([...this.tabs.values()].some((tab) => tab.workspaceId === workspaceId)) return;
      void this.closeBrowser(workspaceId);
    }, this.limits.browserIdleMs);
    timer.unref?.();
    this.browserIdleTimers.set(workspaceId, timer);
  }

  private cancelBrowserIdle(workspaceId: string): void {
    const timer = this.browserIdleTimers.get(workspaceId);
    if (timer) clearTimeout(timer);
    this.browserIdleTimers.delete(workspaceId);
  }

  private ensureTabSweep(): void {
    if (this.tabSweep) return;
    this.tabSweep = setInterval(
      () => this.sweepIdleTabs(),
      Math.min(60_000, this.limits.tabIdleMs),
    );
    this.tabSweep.unref?.();
  }

  public sweepIdleTabs(): void {
    const cutoff = this.now() - this.limits.tabIdleMs;
    for (const tab of this.tabs.values()) {
      if (tab.screencast.viewerCount > 0) tab.touch();
      else if (tab.lastUsedAt < cutoff) void this.closeTab(tab.browserId);
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

  private profileDir(workspaceId: string): string {
    return join(this.options.paseoHome, "server-browser", "profiles", sanitize(workspaceId));
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

function sanitize(workspaceId: string): string {
  return workspaceId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "default";
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
