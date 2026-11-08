import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CdpConnection, pipeTransport, type CdpParams } from "./cdp-connection.js";
import { pickElement } from "./element-picker.js";
import { ServerBrowserHost, type ServerBrowserLimits } from "./server-browser-host.js";
import type { LaunchFn } from "./shared-chromium.js";

/**
 * A stand-in for Chromium's CDP pipe: enough of Target and Storage for the host's lifecycle, with
 * cookies kept per browser context the way Chromium keeps them.
 */
class FakeChromium {
  public launches = 0;
  public readonly contexts = new Map<string, CdpParams[]>();
  public readonly disposed: string[] = [];
  public exited = 0;
  private nextId = 0;

  public readonly launch: LaunchFn = async () => {
    this.launches++;
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const child = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null };
    child.pid = 1000 + this.launches;
    child.exitCode = null;
    const exit = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      this.exited++;
      fromBrowser.end();
      fromBrowser.destroy();
      child.emit("exit", 0, null);
    };
    Object.assign(child, { kill: exit });
    let buffer = "";
    toBrowser.setEncoding("utf8");
    toBrowser.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\0");
      while (end !== -1) {
        const message = JSON.parse(buffer.slice(0, end)) as {
          id: number;
          method: string;
          params: CdpParams;
          sessionId?: string;
        };
        buffer = buffer.slice(end + 1);
        const result = this.answer(message.method, message.params);
        fromBrowser.write(`${JSON.stringify({ id: message.id, result })}\0`);
        if (message.method === "Browser.close") setImmediate(exit);
        end = buffer.indexOf("\0");
      }
    });
    return {
      process: child as unknown as ChildProcess,
      connection: new CdpConnection(pipeTransport(toBrowser, fromBrowser)),
      sandboxed: true,
    };
  };

  private answer(method: string, params: CdpParams): CdpParams {
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: [] };
      case "Target.createBrowserContext": {
        const id = `ctx-${++this.nextId}`;
        this.contexts.set(id, []);
        return { browserContextId: id };
      }
      case "Target.disposeBrowserContext":
        this.contexts.delete(params.browserContextId as string);
        this.disposed.push(params.browserContextId as string);
        return {};
      case "Target.createTarget":
        return { targetId: `target-${++this.nextId}` };
      case "Target.attachToTarget":
        return { sessionId: `session-${++this.nextId}` };
      case "Storage.getCookies":
        return { cookies: this.contexts.get(params.browserContextId as string) ?? [] };
      case "Storage.setCookies":
        this.contexts.set(params.browserContextId as string, params.cookies as CdpParams[]);
        return {};
      default:
        return {};
    }
  }
}

let paseoHome: string;
let chromium: FakeChromium;
const hosts: ServerBrowserHost[] = [];

beforeEach(() => {
  paseoHome = mkdtempSync(join(tmpdir(), "server-browser-host-unit-"));
  chromium = new FakeChromium();
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  rmSync(paseoHome, { recursive: true, force: true });
});

function createHost(limits: Partial<ServerBrowserLimits> = {}): ServerBrowserHost {
  const host = new ServerBrowserHost({
    paseoHome,
    logger: pino({ level: "silent" }),
    isEnabled: () => true,
    resolveExecutable: async () => ({ ok: true, path: "/fake/chromium", source: "config" }),
    launch: chromium.launch,
    limits,
  });
  hosts.push(host);
  return host;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const storageFile = (workspaceId: string) =>
  join(paseoHome, "server-browser", "storage", `${workspaceId}.json`);
const sessionCookie = {
  name: "sid",
  value: "s3cret",
  domain: "localhost",
  path: "/",
  httpOnly: true,
};

function contextIdOf(cookieValue: string): string | undefined {
  for (const [id, cookies] of chromium.contexts) {
    if (cookies.some((cookie) => cookie.value === cookieValue)) return id;
  }
  return undefined;
}

describe("an element pick on a tab that goes away", () => {
  // The client's socket stays open, so nothing but the tab's own teardown can end the pick.
  it.each([
    ["the tab closes", (host: ServerBrowserHost, browserId: string) => host.closeTab(browserId)],
    ["the host shuts down", (host: ServerBrowserHost) => host.shutdown()],
  ])("ends as cancelled when %s", async (_case, tearDown) => {
    const host = createHost();
    const { browserId } = await host.openTab({
      workspaceId: "ws",
      url: "about:blank",
      openedBy: "user",
    });
    const pick = pickElement(host.getTab(browserId)!.contents);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await tearDown(host, browserId);
    const outcome = await Promise.race([
      pick,
      new Promise((resolve) => setTimeout(() => resolve("still polling"), 2_000)),
    ]);
    expect(outcome).toEqual({ outcome: "cancelled" });
  });
});

describe("ServerBrowserHost lifecycle", () => {
  it("opens every workspace in one browser, each in its own context", async () => {
    const host = createHost();
    await host.openTab({ workspaceId: "ws-a", url: "about:blank", openedBy: "agent" });
    await host.openTab({ workspaceId: "ws-b", url: "about:blank", openedBy: "agent" });
    await host.openTab({ workspaceId: "ws-a", url: "about:blank", openedBy: "agent" });
    expect(chromium.launches).toBe(1);
    expect(chromium.contexts.size).toBe(2);
    expect(host.openContextIds().sort()).toEqual(["ws-a", "ws-b"]);
  });

  it("saves and closes a workspace's context once it has no tabs, then exits the browser", async () => {
    const host = createHost({ contextIdleMs: 50, browserIdleMs: 50 });
    const a = await host.openTab({ workspaceId: "ws-a", url: "about:blank", openedBy: "agent" });
    const b = await host.openTab({ workspaceId: "ws-b", url: "about:blank", openedBy: "agent" });
    const [contextA] = [...chromium.contexts.keys()];
    chromium.contexts.set(contextA!, [sessionCookie]);

    await host.closeTab(a.browserId);
    await waitFor(() => chromium.disposed.includes(contextA!));
    expect(host.openContextIds()).toEqual(["ws-b"]);
    expect(JSON.parse(readFileSync(storageFile("ws-a"), "utf8")).cookies).toEqual([sessionCookie]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(chromium.exited).toBe(0);

    await host.closeTab(b.browserId);
    await waitFor(() => chromium.exited === 1);
    expect(host.browserPid()).toBeUndefined();
  });

  it("keeps the context while a tab reopens within the idle window", async () => {
    const host = createHost({ contextIdleMs: 100 });
    const tab = await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    await host.closeTab(tab.browserId);
    await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(chromium.disposed).toEqual([]);
  });

  it("restores a workspace's saved cookies into its new context, and only its own", async () => {
    mkdirSync(join(paseoHome, "server-browser", "storage"), { recursive: true });
    writeFileSync(
      storageFile("ws-a"),
      JSON.stringify({ version: 1, cookies: [sessionCookie], origins: {} }),
    );
    const host = createHost();
    await host.openTab({ workspaceId: "ws-a", url: "about:blank", openedBy: "agent" });
    await host.openTab({ workspaceId: "ws-b", url: "about:blank", openedBy: "agent" });
    const restored = contextIdOf("s3cret");
    expect(restored).toBeDefined();
    expect([...chromium.contexts.values()].filter((cookies) => cookies.length > 0)).toHaveLength(1);
  });

  // Windows has no POSIX mode bits (a directory reports 0o666); the user's profile ACL covers it.
  it.skipIf(process.platform === "win32")(
    "writes storage files only the daemon's user can read",
    async () => {
      const host = createHost();
      await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
      chromium.contexts.set([...chromium.contexts.keys()][0]!, [sessionCookie]);
      await host.saveWorkspaceStorage("ws");
      expect(statSync(join(paseoHome, "server-browser", "storage")).mode & 0o777).toBe(0o700);
    },
  );

  it("saves every open workspace on shutdown", async () => {
    const host = createHost();
    await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    chromium.contexts.set([...chromium.contexts.keys()][0]!, [sessionCookie]);
    await host.shutdown();
    expect(existsSync(storageFile("ws"))).toBe(true);
    expect(chromium.exited).toBe(1);
  });

  it("clears a workspace's data: new empty context, same tab ids, no file", async () => {
    mkdirSync(join(paseoHome, "server-browser", "storage"), { recursive: true });
    writeFileSync(
      storageFile("ws"),
      JSON.stringify({ version: 1, cookies: [sessionCookie], origins: {} }),
    );
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "user" });
    const before = contextIdOf("s3cret")!;

    await host.clearWorkspaceData("ws");

    expect(chromium.disposed).toEqual([before]);
    expect(existsSync(storageFile("ws"))).toBe(false);
    expect(contextIdOf("s3cret")).toBeUndefined();
    expect(host.listTabs().map((info) => info.browserId)).toEqual([tab.browserId]);
    expect(host.getTab(tab.browserId)).not.toBeNull();
  });

  it("caps tabs across every workspace on the host", async () => {
    const host = createHost({ maxTabs: 2 });
    await host.openTab({ workspaceId: "ws-a", url: "about:blank", openedBy: "agent" });
    await host.openTab({ workspaceId: "ws-b", url: "about:blank", openedBy: "agent" });
    await expect(
      host.openTab({ workspaceId: "ws-c", url: "about:blank", openedBy: "agent" }),
    ).rejects.toThrow(/browser_close_tab/);
  });

  it("closes a tab nobody touched within the idle window", async () => {
    let now = 0;
    const host = new ServerBrowserHost({
      paseoHome,
      logger: pino({ level: "silent" }),
      isEnabled: () => true,
      resolveExecutable: async () => ({ ok: true, path: "/fake/chromium", source: "config" }),
      launch: chromium.launch,
      limits: { tabIdleMs: 30 * 60_000 },
      now: () => now,
    });
    hosts.push(host);
    const stale = await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    now = 20 * 60_000;
    const fresh = await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    now = 31 * 60_000;
    host.sweepIdleTabs();
    await waitFor(() => host.listTabs().length === 1);
    expect(host.getTab(stale.browserId)).toBeNull();
    expect(host.getTab(fresh.browserId)).not.toBeNull();
  });
});
