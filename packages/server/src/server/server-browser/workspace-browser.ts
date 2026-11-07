import type { ChildProcess } from "node:child_process";
import {
  launchChromium,
  type CdpConnection,
  type CdpEvent,
  type LaunchChromiumOptions,
} from "./cdp-connection.js";

export interface WorkspaceBrowserTarget {
  targetId: string;
  sessionId: string;
  connection: CdpConnection;
}

export interface WorkspaceBrowserEvents {
  onEvent(event: CdpEvent): void;
  onTargetInfo(info: { targetId: string; url: string; title: string }): void;
  onTargetDestroyed(targetId: string): void;
  onExit(): void;
}

export type LaunchFn = (options: LaunchChromiumOptions) => ReturnType<typeof launchChromium>;

const CLOSE_GRACE_MS = 3_000;

/**
 * One Chromium process per workspace, with a persistent profile directory. A real
 * user-data-dir keeps cookies, localStorage and IndexedDB across browser restarts without
 * serialising storage ourselves, and keeps workspaces apart.
 */
export class WorkspaceBrowser {
  private process: ChildProcess | null = null;
  private connection: CdpConnection | null = null;
  private exited = false;
  public sandboxed = true;

  private constructor(
    public readonly workspaceId: string,
    private readonly events: WorkspaceBrowserEvents,
  ) {}

  public static async launch(params: {
    workspaceId: string;
    executablePath: string;
    userDataDir: string;
    noSandbox: boolean;
    events: WorkspaceBrowserEvents;
    launch?: LaunchFn;
  }): Promise<WorkspaceBrowser> {
    const browser = new WorkspaceBrowser(params.workspaceId, params.events);
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

  public async createTarget(): Promise<WorkspaceBrowserTarget> {
    const connection = this.requireConnection();
    const { targetId } = (await connection.send("Target.createTarget", {
      url: "about:blank",
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
    // Chromium opens a default about:blank page; tabs are always created explicitly.
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
