import type { ChildProcess } from "node:child_process";
import {
  launchChromium,
  type CdpConnection,
  type CdpEvent,
  type CdpParams,
  type LaunchChromiumOptions,
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

/**
 * The daemon's one Chromium process. Each workspace gets its own browser context inside it:
 * contexts share the browser, GPU, network and zygote processes but never cookies, storage or
 * renderers. Contexts live in memory only; `workspace-storage-state.ts` persists what they hold.
 */
export class SharedChromium {
  private process: ChildProcess | null = null;
  private connection: CdpConnection | null = null;
  private exited = false;
  public sandboxed = true;

  private constructor(private readonly events: SharedChromiumEvents) {}

  public static async launch(params: {
    executablePath: string;
    userDataDir: string;
    noSandbox: boolean;
    events: SharedChromiumEvents;
    launch?: LaunchFn;
  }): Promise<SharedChromium> {
    const browser = new SharedChromium(params.events);
    const launched = await (params.launch ?? launchChromium)({
      executablePath: params.executablePath,
      userDataDir: params.userDataDir,
      noSandbox: params.noSandbox,
    });
    browser.process = launched.process;
    browser.connection = launched.connection;
    browser.sandboxed = launched.sandboxed;
    launched.connection.on("event", (event) => browser.handleEvent(event));
    launched.connection.on("close", () => browser.markExited());
    launched.process.once("exit", () => browser.markExited());
    await browser.prepare();
    return browser;
  }

  public get isAlive(): boolean {
    return !this.exited;
  }

  public get pid(): number | undefined {
    return this.process?.pid;
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

  public async createTarget(browserContextId: string): Promise<ChromiumTarget> {
    const connection = this.requireConnection();
    const { targetId } = (await connection.send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    })) as { targetId: string };
    const { sessionId } = (await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    return { targetId, sessionId, connection };
  }

  public async closeTarget(targetId: string): Promise<void> {
    if (this.exited) return;
    await this.requireConnection()
      .send("Target.closeTarget", { targetId })
      .catch(() => {});
  }

  public async getCookies(browserContextId: string): Promise<ChromiumCookie[]> {
    const { cookies } = (await this.requireConnection().send("Storage.getCookies", {
      browserContextId,
    })) as { cookies: ChromiumCookie[] };
    return cookies.map(toCookieParam);
  }

  public async setCookies(browserContextId: string, cookies: ChromiumCookie[]): Promise<void> {
    if (cookies.length === 0) return;
    await this.requireConnection().send("Storage.setCookies", { cookies, browserContextId });
  }

  public async close(): Promise<void> {
    if (this.exited) return;
    const child = this.process;
    const exited = new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    void this.connection?.send("Browser.close").catch(() => {});
    const timer = setTimeout(() => child?.kill("SIGKILL"), CLOSE_GRACE_MS);
    await exited;
    clearTimeout(timer);
    this.markExited();
  }

  private async prepare(): Promise<void> {
    const connection = this.requireConnection();
    await connection.send("Target.setDiscoverTargets", { discover: true });
    await connection.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    // Chromium opens a default about:blank page in its default context, which tabs never use.
    const { targetInfos } = (await connection.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string }>;
    };
    for (const target of targetInfos) {
      if (target.type === "page") await this.closeTarget(target.targetId);
    }
  }

  private handleEvent(event: CdpEvent): void {
    if (event.method === "Target.targetInfoChanged") {
      const info = event.params.targetInfo as
        | { targetId: string; url: string; title: string; type: string }
        | undefined;
      if (info?.type === "page") this.events.onTargetInfo(info);
      return;
    }
    if (event.method === "Target.targetDestroyed") {
      const targetId = event.params.targetId;
      if (typeof targetId === "string") this.events.onTargetDestroyed(targetId);
      return;
    }
    if (event.sessionId) this.events.onEvent(event);
  }

  private requireConnection(): CdpConnection {
    if (!this.connection || this.exited) throw new Error("The server browser is not running");
    return this.connection;
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    this.events.onExit();
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
