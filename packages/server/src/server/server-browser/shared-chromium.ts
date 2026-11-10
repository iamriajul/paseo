import type { ChildProcess } from "node:child_process";
import {
  launchChromium,
  type CdpConnection,
  type CdpEvent,
  type CdpParams,
  type LaunchChromiumOptions,
  ServerBrowserUnavailableError,
} from "./cdp-connection.js";

export interface ChromiumTarget {
  targetId: string;
  sessionId: string;
  connection: CdpConnection;
}

export interface SharedChromiumEvents {
  onEvent(event: CdpEvent): void;
  onTargetInfo(info: { targetId: string; url: string; title: string }): void;
  onTargetDestroyed(targetId: string): void;
  /** One of this daemon's pages opened a page (window.open, a target=_blank link); it is ours too. */
  onPopup?(popup: { targetId: string; openerId: string }): void;
  onExit(): void;
}

export type LaunchFn = (options: LaunchChromiumOptions) => ReturnType<typeof launchChromium>;

/** A cookie as `Storage.getCookies` returns it; only the fields `Storage.setCookies` takes are kept. */
export type ChromiumCookie = CdpParams & { name: string; value: string; domain: string };

const CLOSE_GRACE_MS = 3_000;
const COOKIE_PARAM_FIELDS = [
  "name",
  "value",
  "domain",
  "path",
  "secure",
  "httpOnly",
  "sameSite",
  "expires",
  "priority",
  "sourceScheme",
  "sourcePort",
  "partitionKey",
] as const;

export interface SharedChromiumStart {
  connection: CdpConnection;
  /** Present when the daemon launched the browser and may close it; absent for one it attached to. */
  process?: ChildProcess;
  sandboxed?: boolean;
  /** Headed: each tab gets its own background window, because a tab behind another never paints. */
  newWindowPerTab?: boolean;
  /** Runs once the browser is gone, e.g. to stop the virtual display it ran on. */
  onGone?: () => void;
  events: SharedChromiumEvents;
}

/**
 * The daemon's one browser, whatever the engine. An owned browser was launched by the daemon and
 * is closed by it. An attached browser belongs to someone else: the daemon only ever acts on the
 * targets it created there, closes those when it leaves, and never closes the browser.
 * Workspaces get their own browser context when the engine isolates them (`createContext`).
 */
export class SharedChromium {
  private readonly ownTargets = new Set<string>();
  /** A headed browser's startup window, kept until the first tab exists (see `prepare`). */
  private startupPages: string[] = [];
  private exited = false;
  public readonly sandboxed: boolean;

  private constructor(private readonly params: SharedChromiumStart) {
    this.sandboxed = params.sandboxed ?? true;
  }

  public static async launch(params: {
    executablePath: string;
    userDataDir: string;
    noSandbox: boolean;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    newWindowPerTab?: boolean;
    onGone?: () => void;
    events: SharedChromiumEvents;
    launch?: LaunchFn;
  }): Promise<SharedChromium> {
    const launched = await (params.launch ?? launchChromium)({
      executablePath: params.executablePath,
      userDataDir: params.userDataDir,
      noSandbox: params.noSandbox,
      ...(params.args ? { args: params.args } : {}),
      ...(params.env ? { env: params.env } : {}),
    });
    return SharedChromium.start({
      connection: launched.connection,
      process: launched.process,
      sandboxed: launched.sandboxed,
      ...(params.newWindowPerTab ? { newWindowPerTab: true } : {}),
      ...(params.onGone ? { onGone: params.onGone } : {}),
      events: params.events,
    });
  }

  public static async start(params: SharedChromiumStart): Promise<SharedChromium> {
    const browser = new SharedChromium(params);
    params.connection.on("event", (event) => browser.handleEvent(event));
    params.connection.on("close", () => browser.markExited());
    params.process?.once("exit", () => browser.markExited());
    try {
      await browser.prepare();
    } catch (error) {
      await browser.close();
      throw error;
    }
    return browser;
  }

  public get isAlive(): boolean {
    return !this.exited;
  }

  public get isOwned(): boolean {
    return this.params.process !== undefined;
  }

  public get pid(): number | undefined {
    return this.params.process?.pid;
  }

  public get cdp(): CdpConnection {
    return this.requireConnection();
  }

  public async createContext(): Promise<string> {
    const connection = this.requireConnection();
    const { browserContextId } = (await connection.send("Target.createBrowserContext", {
      disposeOnDetach: true,
    })) as { browserContextId: string };
    // Download behaviour is per context; one left at the default would save files on the host.
    await connection.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId });
    return browserContextId;
  }

  public async disposeContext(browserContextId: string): Promise<void> {
    if (this.exited) return;
    await this.requireConnection()
      .send("Target.disposeBrowserContext", { browserContextId })
      .catch(() => {});
  }

  /** A new page target; in the browser's default context when no context id is given. */
  public async createTarget(browserContextId?: string): Promise<ChromiumTarget> {
    const connection = this.requireConnection();
    const { targetId } = (await connection.send("Target.createTarget", {
      url: "about:blank",
      ...(browserContextId ? { browserContextId } : {}),
      ...(this.params.newWindowPerTab ? { newWindow: true, background: true } : {}),
    })) as { targetId: string };
    this.ownTargets.add(targetId);
    for (const startup of this.startupPages.splice(0)) {
      await connection.send("Target.closeTarget", { targetId: startup }).catch(() => {});
    }
    return this.attachTarget(targetId);
  }

  /** Attaches to one of this daemon's targets: one it created, or a popup one of them opened. */
  public async attachTarget(targetId: string): Promise<ChromiumTarget> {
    const connection = this.requireConnection();
    const { sessionId } = (await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    if (!this.isOwned) {
      // The browser-wide setting is its owner's; refuse downloads on our own pages instead.
      await connection
        .send("Page.setDownloadBehavior", { behavior: "deny" }, sessionId)
        .catch(() => {});
    }
    return { targetId, sessionId, connection };
  }

  public async closeTarget(targetId: string): Promise<void> {
    // Never a target this daemon did not create: an attached browser's other tabs are its owner's.
    if (this.exited || !this.ownTargets.delete(targetId)) return;
    await this.requireConnection()
      .send("Target.closeTarget", { targetId })
      .catch(() => {});
  }

  /** The context's cookies, or the default context's; `sessionOnly` keeps those with no expiry. */
  public async getCookies(
    browserContextId: string | null,
    options: { sessionOnly?: boolean } = {},
  ): Promise<ChromiumCookie[]> {
    const { cookies } = (await this.requireConnection().send(
      "Storage.getCookies",
      browserContextId ? { browserContextId } : {},
    )) as { cookies: ChromiumCookie[] };
    const kept = options.sessionOnly
      ? cookies.filter((cookie) => cookie.session === true)
      : cookies;
    return kept.map(toCookieParam);
  }

  public async setCookies(
    browserContextId: string | null,
    cookies: ChromiumCookie[],
  ): Promise<void> {
    if (cookies.length === 0) return;
    await this.requireConnection().send("Storage.setCookies", {
      cookies,
      ...(browserContextId ? { browserContextId } : {}),
    });
  }

  /** Owned: closes the browser. Attached: closes this daemon's tabs and disconnects. */
  public async close(): Promise<void> {
    if (this.exited) return;
    const child = this.params.process;
    if (!child) {
      await Promise.all([...this.ownTargets].map((targetId) => this.closeTarget(targetId)));
      this.params.connection.disconnect();
      this.markExited();
      return;
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    void this.params.connection.send("Browser.close").catch(() => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
    await exited;
    clearTimeout(timer);
    this.markExited();
  }

  private async prepare(): Promise<void> {
    const connection = this.requireConnection();
    await connection.send("Target.setDiscoverTargets", { discover: true });
    if (!this.isOwned) return;
    await connection.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    // A launched browser opens a default about:blank page, which tabs never use. A headed Chrome
    // left with no window quits on the next profile write (Storage.setCookies does it), so its
    // startup window stays until the first tab has its own.
    const { targetInfos } = (await connection.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string }>;
    };
    const pages = targetInfos.filter((target) => target.type === "page").map((t) => t.targetId);
    if (this.params.newWindowPerTab) {
      this.startupPages = pages;
      return;
    }
    for (const targetId of pages) {
      await connection.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  private handleEvent(event: CdpEvent): void {
    if (event.method === "Target.targetCreated") {
      this.onTargetCreated(
        event.params.targetInfo as
          | { targetId: string; type: string; openerId?: string }
          | undefined,
      );
      return;
    }
    if (event.method === "Target.targetInfoChanged") {
      const info = event.params.targetInfo as
        | { targetId: string; url: string; title: string; type: string }
        | undefined;
      if (info?.type === "page" && this.ownTargets.has(info.targetId)) {
        this.events().onTargetInfo(info);
      }
      return;
    }
    if (event.method === "Target.targetDestroyed") {
      const targetId = event.params.targetId;
      if (typeof targetId === "string" && this.ownTargets.delete(targetId)) {
        this.events().onTargetDestroyed(targetId);
      }
      return;
    }
    if (event.sessionId) this.events().onEvent(event);
  }

  private onTargetCreated(
    info: { targetId: string; type: string; openerId?: string } | undefined,
  ): void {
    // An Existing browser's owner opens pages too; only a page one of ours opened is ours.
    if (info?.type !== "page" || !info.openerId || !this.ownTargets.has(info.openerId)) return;
    this.ownTargets.add(info.targetId);
    this.events().onPopup?.({ targetId: info.targetId, openerId: info.openerId });
  }

  private events(): SharedChromiumEvents {
    return this.params.events;
  }

  private requireConnection(): CdpConnection {
    if (this.exited) throw new ServerBrowserUnavailableError("The server browser is not running");
    return this.params.connection;
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    this.params.onGone?.();
    this.events().onExit();
  }
}

function toCookieParam(cookie: ChromiumCookie): ChromiumCookie {
  const param: CdpParams = {};
  for (const field of COOKIE_PARAM_FIELDS) {
    if (cookie[field] !== undefined) param[field] = cookie[field];
  }
  // A session cookie reports expires -1; setCookies would read that as already expired.
  if (cookie.session === true || (typeof param.expires === "number" && param.expires < 0)) {
    delete param.expires;
  }
  return param as ChromiumCookie;
}
