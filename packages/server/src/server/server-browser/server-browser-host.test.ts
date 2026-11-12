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
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
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
  /** Every page command, in the order the browser received it. */
  public readonly pageCommands: Array<{ method: string; params: CdpParams }> = [];
  /** How long a page takes to acknowledge a mouse event. */
  public mouseAckMs = 0;
  /** Page commands this browser never answers. */
  public readonly unanswered = new Set<string>();
  /** Targets the daemon closed (Target.closeTarget), in order. */
  public readonly closedTargets: string[] = [];
  /** The page's scroll position, as the suspend capture reads it. */
  public scroll: [number, number] = [0, 0];
  /** Ends the running browser as a crash would. */
  public crash: () => void = () => {};
  /** Sends a CDP event from the running browser, as a page would cause one. */
  public emit: (event: { method: string; params: CdpParams; sessionId: string }) => void = () => {};
  private nextId = 0;
  private readonly targetOfSession = new Map<string, string>();
  private readonly urlOfSession = new Map<string, string>();

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
    this.crash = exit;
    this.emit = (event) => fromBrowser.write(`${JSON.stringify(event)}\0`);
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
        if (message.sessionId) this.pageCommands.push(message);
        const result = this.answer(message.method, message.params, message.sessionId);
        // A navigation loads at once: the main frame starts, commits and stops loading.
        if (message.method === "Page.navigate" && message.sessionId) {
          const sessionId = message.sessionId;
          const frameId = this.targetOfSession.get(sessionId);
          const url = message.params.url as string;
          setImmediate(() => {
            this.emit({ method: "Page.frameStartedLoading", params: { frameId }, sessionId });
            this.emit({
              method: "Page.frameNavigated",
              params: { frame: { id: frameId, url } },
              sessionId,
            });
            this.emit({ method: "Page.frameStoppedLoading", params: { frameId }, sessionId });
          });
        }
        const reply = () => fromBrowser.write(`${JSON.stringify({ id: message.id, result })}\0`);
        if (this.unanswered.has(message.method)) {
          // Never answered.
        } else if (message.method === "Input.dispatchMouseEvent" && this.mouseAckMs > 0) {
          setTimeout(reply, this.mouseAckMs);
        } else {
          reply();
        }
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

  private answer(method: string, params: CdpParams, pageSession?: string): CdpParams {
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
      case "Target.attachToTarget": {
        const sessionId = `session-${++this.nextId}`;
        this.targetOfSession.set(sessionId, params.targetId as string);
        return { sessionId };
      }
      case "Target.closeTarget":
        this.closedTargets.push(params.targetId as string);
        return { success: true };
      case "Page.captureScreenshot":
        return { data: Buffer.from(`frame:${params.format as string}`).toString("base64") };
      case "Runtime.evaluate": {
        const expression = params.expression as string;
        if (expression === "[window.scrollX, window.scrollY]")
          return { result: { value: this.scroll } };
        if (expression.includes("window.scrollTo(")) return { result: { value: true } };
        const url = pageSession ? this.urlOfSession.get(pageSession) : undefined;
        if (expression === "location.origin" && url)
          return { result: { value: new URL(url).origin } };
        return {};
      }
      case "Page.navigate": {
        if (pageSession) this.urlOfSession.set(pageSession, params.url as string);
        return {};
      }
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

function createHost(
  limits: Partial<ServerBrowserLimits> = {},
  now?: () => number,
): ServerBrowserHost {
  const host = new ServerBrowserHost({
    paseoHome,
    logger: pino({ level: process.env.SB_DEBUG ? "debug" : "silent" }),
    isEnabled: () => true,
    resolveExecutable: async () => ({ ok: true, path: "/fake/chromium", source: "config" }),
    launch: chromium.launch,
    limits,
    ...(now ? { now } : {}),
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

const PAGE = "http://localhost:4100/";
const SIZE = { maxWidth: 1280, maxHeight: 800 };
const suspendedFile = (browserId: string) =>
  join(paseoHome, "server-browser", "suspended-tabs", `${browserId}.json`);
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

describe("viewer input on a page slow to acknowledge it", () => {
  it("sends the newest of the moves still waiting, so a click is not stuck behind them", async () => {
    const host = createHost();
    const { browserId } = await host.openTab({
      workspaceId: "ws",
      url: "about:blank",
      openedBy: "user",
    });
    chromium.mouseAckMs = 100;
    const tab = host.getTab(browserId)!;
    const move = (x: number) =>
      tab.dispatchInput([
        { kind: "mouse", action: "move", x, y: 0.5, button: "none", clickCount: 0 },
      ]);
    // A second of pointer moves at 60 Hz, then a click.
    const moves = Array.from({ length: 60 }, (_, step) => move(step / 100));
    const startedAt = Date.now();
    await tab.dispatchInput([
      { kind: "mouse", action: "down", x: 0.7, y: 0.5, button: "left", clickCount: 1 },
      { kind: "mouse", action: "up", x: 0.7, y: 0.5, button: "left", clickCount: 1 },
    ]);
    await Promise.all(moves);

    const mouse = chromium.pageCommands.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(mouse.map((c) => [c.params.type, c.params.x])).toEqual([
      ["mouseMoved", 0.59 * 1280],
      ["mousePressed", 0.7 * 1280],
      ["mouseReleased", 0.7 * 1280],
    ]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
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

  it("caps live tabs across every workspace, refusing a new one when every tab is watched", async () => {
    const host = createHost({ maxTabs: 2 });
    for (const workspaceId of ["ws-a", "ws-b"]) {
      const tab = await host.openTab({ workspaceId, url: "about:blank", openedBy: "agent" });
      tab.screencast.addViewer("v", { send: () => {}, isCongested: () => false }, SIZE);
    }
    await expect(
      host.openTab({ workspaceId: "ws-c", url: "about:blank", openedBy: "agent" }),
    ).rejects.toThrow(/browser_close_tab/);
  });

  it("opens a new tab past the limit by suspending the idlest unwatched one, and says which", async () => {
    let now = 0;
    const host = createHost({ maxTabs: 2 }, () => now);
    const idlest = await host.openTab({ workspaceId: "ws-a", url: PAGE, openedBy: "agent" });
    now = 1_000;
    const watched = await host.openTab({ workspaceId: "ws-b", url: PAGE, openedBy: "agent" });
    watched.screencast.addViewer("v", { send: () => {}, isCongested: () => false }, SIZE);
    now = 2_000;

    const response = await host.execute({
      type: "browser.automation.execute.request",
      requestId: "r",
      workspaceId: "ws-c",
      command: { command: "new_tab", args: { url: PAGE } },
    });

    expect(response).toMatchObject({ ok: true, result: { command: "new_tab" } });
    expect(response.notice).toContain(`suspended the one used longest ago`);
    expect(response.notice).toContain(`browserId=${idlest.browserId} (${PAGE})`);
    expect(idlest.isSuspended).toBe(true);
    expect(watched.isSuspended).toBe(false);
    expect(host.listTabs()).toHaveLength(3);
  });

  it("suspends a tab nobody touched within the idle window, keeping its URL and last frame", async () => {
    let now = 0;
    const host = createHost({ tabIdleMs: 10 * 60_000 }, () => now);
    chromium.scroll = [0, 640];
    const stale = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    const staleTarget = stale.cdpTargetId;
    now = 5 * 60_000;
    const fresh = await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    now = 11 * 60_000;

    await host.sweepIdleTabs();

    expect(chromium.closedTargets).toEqual([staleTarget]);
    expect(host.listTabs()).toEqual([
      expect.objectContaining({ browserId: stale.browserId, url: PAGE, suspended: true }),
      expect.not.objectContaining({ suspended: true }),
    ]);
    expect(host.getTab(fresh.browserId)?.isSuspended).toBe(false);
    expect(Buffer.from(stale.currentStillFrame!.jpeg).toString()).toBe("frame:jpeg");
    expect(stale.suspendedState?.scroll).toEqual({ x: 0, y: 640 });
    expect(existsSync(suspendedFile(stale.browserId))).toBe(true);
  });

  it("keeps a watched tab live however long nobody else touches it", async () => {
    let now = 0;
    const host = createHost({ tabIdleMs: 10 * 60_000 }, () => now);
    const tab = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    tab.screencast.addViewer("v", { send: () => {}, isCongested: () => false }, SIZE);
    now = 60 * 60_000;
    await host.sweepIdleTabs();
    expect(tab.isSuspended).toBe(false);
    expect(chromium.closedTargets).toEqual([]);
  });

  it("reloads a suspended tab at its URL and scroll for an agent's command, and says so", async () => {
    const host = createHost();
    chromium.scroll = [0, 640];
    const tab = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    await host.suspendTab(tab.browserId);
    const listed = await host.execute({
      type: "browser.automation.execute.request",
      requestId: "list",
      workspaceId: "ws",
      command: { command: "list_tabs", args: {} },
    });
    expect(listed).toMatchObject({
      ok: true,
      result: { tabs: [{ browserId: tab.browserId, suspended: true }] },
    });
    expect(listed).not.toHaveProperty("notice");
    expect(tab.isSuspended).toBe(true);
    chromium.pageCommands.length = 0;

    const response = await host.execute({
      type: "browser.automation.execute.request",
      requestId: "r",
      workspaceId: "ws",
      command: { command: "reload", args: { browserId: tab.browserId } },
    });

    expect(response.notice).toMatch(/suspended it to free memory.*reloaded its page at http/);
    expect(response.notice).toMatch(/take a new snapshot/);
    expect(tab.isSuspended).toBe(false);
    expect(tab.cdpTargetId).not.toBe("");
    const methods = chromium.pageCommands.map((command) => command.method);
    expect(chromium.pageCommands).toContainEqual(
      expect.objectContaining({ method: "Page.navigate", params: { url: PAGE } }),
    );
    expect(
      chromium.pageCommands.some(
        (command) =>
          command.method === "Runtime.evaluate" &&
          String(command.params.expression).includes("window.scrollTo(0, 640)"),
      ),
    ).toBe(true);
    expect(methods.indexOf("Page.navigate")).toBeLessThan(methods.lastIndexOf("Page.reload"));
    expect(existsSync(suspendedFile(tab.browserId))).toBe(false);
  });

  it("shows a viewer the suspended page's frame, then wakes the tab for it", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    await host.suspendTab(tab.browserId);
    const frames: string[] = [];
    tab.screencast.addViewer(
      "v",
      {
        send: (frame) => frames.push(Buffer.from(frame.jpeg).toString()),
        isCongested: () => false,
      },
      SIZE,
    );
    expect(frames).toEqual(["frame:jpeg"]);
    await waitFor(() => !tab.isSuspended && tab.currentStillFrame === null);
    expect(chromium.pageCommands).toContainEqual(
      expect.objectContaining({ method: "Page.startScreencast" }),
    );
  });

  it("frees the workspace's context and the browser once its only tab is suspended", async () => {
    const host = createHost({ contextIdleMs: 50, browserIdleMs: 50 });
    const tab = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    await host.suspendTab(tab.browserId);
    await waitFor(() => chromium.exited === 1);
    expect(host.openContextIds()).toEqual([]);
    expect(host.listTabs()).toEqual([expect.objectContaining({ suspended: true })]);

    await host.wakeTab(tab);
    expect(chromium.launches).toBe(2);
    expect(tab.info()).toMatchObject({ url: PAGE });
    expect(tab.isSuspended).toBe(false);
  });

  it("brings suspended and open tabs back suspended after a daemon restart, same ids", async () => {
    const first = createHost();
    const suspended = await first.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    await first.suspendTab(suspended.browserId);
    const open = await first.openTab({ workspaceId: "ws", url: `${PAGE}open`, openedBy: "user" });
    await first.shutdown();

    const second = createHost();
    await second.loadSuspendedTabs();

    expect(second.listTabs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ browserId: suspended.browserId, url: PAGE, suspended: true }),
        expect.objectContaining({ browserId: open.browserId, url: `${PAGE}open`, suspended: true }),
      ]),
    );
    const restored = second.getTab(suspended.browserId)!;
    expect(Buffer.from(restored.currentStillFrame!.jpeg).toString()).toBe("frame:jpeg");
    await second.wakeTab(restored);
    expect(restored.isSuspended).toBe(false);
  });

  it("drops saved suspended tabs when the server browser is off at startup", async () => {
    const first = createHost();
    const tab = await first.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    await first.suspendTab(tab.browserId);
    const off = new ServerBrowserHost({
      paseoHome,
      logger: pino({ level: "silent" }),
      isEnabled: () => false,
    });
    await off.loadSuspendedTabs();
    expect(off.listTabs()).toEqual([]);
    expect(existsSync(suspendedFile(tab.browserId))).toBe(false);
  });

  it("keeps at most maxSuspendedTabs, closing the one used longest ago", async () => {
    let now = 0;
    const host = createHost({ maxSuspendedTabs: 1 }, () => now);
    const older = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    now = 1_000;
    const newer = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    await host.suspendTab(older.browserId);
    await host.suspendTab(newer.browserId);
    await waitFor(() => host.listTabs().length === 1);
    expect(host.listTabs()[0]?.browserId).toBe(newer.browserId);
    await waitFor(() => !existsSync(suspendedFile(older.browserId)));
  });

  it("closes a suspended tab nobody used for suspendedTabTtlMs", async () => {
    let now = 0;
    const host = createHost({ tabIdleMs: 1_000, suspendedTabTtlMs: 10_000 }, () => now);
    const tab = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    now = 2_000;
    await host.sweepIdleTabs();
    expect(tab.isSuspended).toBe(true);
    now = 20_000;
    await host.sweepIdleTabs();
    expect(host.listTabs()).toEqual([]);
  });

  it("does not count suspended tabs toward the limit; a waking tab suspends the idlest live one", async () => {
    let now = 0;
    const host = createHost({ maxTabs: 2 }, () => now);
    const a = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    await host.suspendTab(a.browserId);
    now = 1_000;
    const b = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    now = 2_000;
    const c = await host.openTab({ workspaceId: "ws", url: PAGE, openedBy: "agent" });
    c.screencast.addViewer("v", { send: () => {}, isCongested: () => false }, SIZE);

    await host.wakeTab(a);

    expect(a.isSuspended).toBe(false);
    expect(b.isSuspended).toBe(true);
    expect(c.isSuspended).toBe(false);
  });

  it("tells an agent to retry when the browser is not there, not that something unknown failed", async () => {
    const existing = new ServerBrowserHost({
      paseoHome,
      logger: pino({ level: "silent" }),
      isEnabled: () => true,
      getEngine: () => ({ kind: "existing", cdpUrl: "http://127.0.0.1:9" }),
    });
    hosts.push(existing);
    const unreachable = await existing.execute({
      type: "browser.automation.execute.request",
      requestId: "r1",
      workspaceId: "ws",
      command: { command: "new_tab", args: { url: "https://example.com/" } },
    });
    expect(unreachable).toMatchObject({
      ok: false,
      error: { code: "browser_no_host", retryable: true, message: /No browser answers/ },
    });

    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    chromium.unanswered.add("Runtime.evaluate");
    const snapshot = host.execute({
      type: "browser.automation.execute.request",
      requestId: "r2",
      workspaceId: "ws",
      command: { command: "snapshot", args: { browserId: tab.browserId } },
    });
    const evaluating = () => chromium.pageCommands.some(isEvaluate);
    await waitFor(evaluating);
    chromium.crash();
    expect(await snapshot).toMatchObject({
      ok: false,
      error: { code: "browser_no_host", retryable: true, message: /Open a new tab/ },
    });
  });

  it("says a tab closed with the browser and to open a new one, when its id is used later", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    chromium.crash();
    await waitFor(() => host.listTabs().length === 0);

    expect(host.ownsTab(tab.browserId)).toBe(true);
    expect(
      await host.execute({
        type: "browser.automation.execute.request",
        requestId: "r",
        workspaceId: "ws",
        command: { command: "snapshot", args: { browserId: tab.browserId } },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "browser_tab_closed",
        message: `Browser tab ${tab.browserId} closed when the server browser stopped. Open a new tab with browser_new_tab.`,
      },
    });
  });

  it("waits for an Existing browser that went away to come back before opening a new tab", async () => {
    const browser = await FakeExistingBrowser.start();
    const host = new ServerBrowserHost({
      paseoHome,
      logger: pino({ level: "silent" }),
      isEnabled: () => true,
      getEngine: () => ({ kind: "existing", cdpUrl: browser.url }),
      limits: { reattachWaitMs: 5_000 },
    });
    hosts.push(host);
    await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    await browser.stop();
    await waitFor(() => host.listTabs().length === 0);
    setTimeout(() => void browser.restart(), 1_500);

    const reopened = await host.execute({
      type: "browser.automation.execute.request",
      requestId: "r",
      workspaceId: "ws",
      command: { command: "new_tab", args: { url: "about:blank" } },
    });
    await browser.stop();
    expect(reopened).toMatchObject({ ok: true, result: { command: "new_tab" } });
  });
});

/** A browser someone else runs, reached over its DevTools port; it can go away and come back. */
class FakeExistingBrowser {
  private server: WebSocketServer | null = null;
  private http: Server | null = null;
  private nextId = 0;

  private constructor(private readonly port: number) {}

  public static async start(): Promise<FakeExistingBrowser> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const browser = new FakeExistingBrowser(port);
    await browser.restart();
    return browser;
  }

  public get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public async restart(): Promise<void> {
    const http = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools` }));
    });
    const server = new WebSocketServer({ server: http });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const { id, method } = JSON.parse(String(data)) as { id: number; method: string };
        socket.send(JSON.stringify({ id, result: this.answer(method) }));
      });
    });
    await new Promise<void>((resolve) => http.listen(this.port, "127.0.0.1", resolve));
    this.http = http;
    this.server = server;
  }

  private answer(method: string): CdpParams {
    if (method === "Target.createTarget") return { targetId: `target-${++this.nextId}` };
    if (method === "Target.attachToTarget") return { sessionId: `session-${++this.nextId}` };
    return {};
  }

  public async stop(): Promise<void> {
    const { server, http } = this;
    this.server = null;
    this.http = null;
    for (const client of server?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    http?.closeAllConnections();
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  }
}

describe("a page that logs in a tight loop", () => {
  it("stops reading its console past the budget, then says how many messages it dropped", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: "about:blank", openedBy: "agent" });
    const sessionId = (
      chromium.pageCommands.find((command) => command.method === "Runtime.enable") as {
        sessionId: string;
      }
    ).sessionId;
    const log = (text: string) =>
      chromium.emit({
        method: "Runtime.consoleAPICalled",
        params: { type: "log", args: [{ type: "string", value: text }] },
        sessionId,
      });
    const runtimeCommands = () =>
      chromium.pageCommands
        .filter((command) => command.method.startsWith("Runtime.") && "sessionId" in command)
        .filter((command) => (command as { sessionId: string }).sessionId === sessionId)
        .map((command) => command.method)
        .filter((method) => method !== "Runtime.evaluate" && method !== "Runtime.addBinding");
    for (let index = 0; index < 3_000; index++) log(`flood ${index}`);
    await waitFor(() => runtimeCommands().includes("Runtime.disable"));

    const console = () => host.getTab(tab.browserId)!.consoleSince(0);
    expect(console().length).toBeLessThanOrEqual(1_000);
    const dropped = () => console().some(isDropMarker);
    await waitFor(dropped, 4_000);
    expect(runtimeCommands()).toEqual([
      "Runtime.enable",
      "Runtime.disable",
      "Runtime.discardConsoleEntries",
      "Runtime.enable",
    ]);
    expect(console().at(-1)).toMatchObject({
      level: "warning",
      message: expect.stringMatching(
        /^2000 console messages dropped: the page logged more than 1000/,
      ),
    });

    log("after the pause");
    await waitFor(() => console().at(-1)?.message === "after the pause");
  });
});

function isDropMarker(entry: { message: string }): boolean {
  return /messages dropped/.test(entry.message);
}

function isEvaluate(command: { method: string }): boolean {
  return command.method === "Runtime.evaluate";
}
