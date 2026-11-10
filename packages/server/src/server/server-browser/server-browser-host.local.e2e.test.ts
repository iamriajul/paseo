import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerBrowserHost, type ServerBrowserLimits } from "./server-browser-host.js";

// Local-only: needs a Chromium on this machine (`npx playwright install chromium-headless-shell`).

let paseoHome: string;
let site: http.Server;
let siteUrl: string;
let otherSite: http.Server;
let otherUrl: string;
const hosts: ServerBrowserHost[] = [];

beforeEach(async () => {
  paseoHome = mkdtempSync(join(tmpdir(), "server-browser-host-"));
  site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    // A dev app's login: an httpOnly session cookie with no expiry, which page script cannot see.
    if (req.url === "/login") res.setHeader("set-cookie", "sid=s3cret; HttpOnly; Path=/");
    if (req.url === "/whoami") {
      res.end(
        `<title>${/sid=s3cret/.test(req.headers.cookie ?? "") ? "signed in" : "anonymous"}</title>`,
      );
      return;
    }
    if (req.url === "/slow") {
      // A page that starts and never finishes loading.
      res.write("<title>Slow</title><p>slow page</p>");
      return;
    }
    res.end(
      "<title>Fixture</title><p>fixture page</p>" +
        "<button id=add style='position:fixed;left:0;top:0;width:400px;height:400px' " +
        "onclick='this.dataset.n=(+this.dataset.n||0)+1'>add</button>",
    );
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  siteUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  otherSite = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<title>Other</title>");
  });
  await new Promise<void>((resolve) => otherSite.listen(0, "127.0.0.1", resolve));
  const otherAddress = otherSite.address();
  otherUrl = `http://127.0.0.1:${typeof otherAddress === "object" && otherAddress ? otherAddress.port : 0}/`;
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await new Promise<void>((resolve) => otherSite.close(() => resolve()));
  rmSync(paseoHome, { recursive: true, force: true });
});

function createHost(limits: Partial<ServerBrowserLimits> = {}): ServerBrowserHost {
  const host = new ServerBrowserHost({
    paseoHome,
    logger: pino({ level: "silent" }),
    isEnabled: () => true,
    limits,
  });
  hosts.push(host);
  return host;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function evaluate(host: ServerBrowserHost, browserId: string, script: string) {
  return host.getTab(browserId)!.contents.executeJavaScript(script);
}

describe("ServerBrowserHost with a real Chromium", () => {
  it("runs every workspace in one Chromium, closes an idle workspace's context, then exits", async () => {
    const host = createHost({ contextIdleMs: 200, browserIdleMs: 200 });
    const a = await host.openTab({ workspaceId: "ws-a", url: siteUrl, openedBy: "user" });
    const pid = host.browserPid()!;
    const b = await host.openTab({ workspaceId: "ws-b", url: siteUrl, openedBy: "user" });
    expect(host.browserPid()).toBe(pid);
    expect(host.listTabs().map((info) => info.title)).toEqual(["Fixture", "Fixture"]);

    await host.closeTab(a.browserId);
    await waitFor(() => host.openContextIds().join() === "ws-b");
    expect(isRunning(pid)).toBe(true);

    await host.closeTab(b.browserId);
    await waitFor(() => host.openContextIds().length === 0);
    await waitFor(() => !isRunning(pid));
  });

  it("keeps workspaces' cookies and localStorage apart inside the one browser", async () => {
    const host = createHost();
    const a = await host.openTab({ workspaceId: "ws-a", url: siteUrl, openedBy: "user" });
    await evaluate(host, a.browserId, "document.cookie = 'x=1'; localStorage.setItem('k', 'a')");
    const b = await host.openTab({ workspaceId: "ws-b", url: siteUrl, openedBy: "user" });
    expect(await evaluate(host, b.browserId, "document.cookie")).toBe("");
    expect(await evaluate(host, b.browserId, "localStorage.getItem('k')")).toBeNull();
  });

  it("keeps a login across the workspace's context closing and across a browser restart", async () => {
    const first = createHost({ contextIdleMs: 100 });
    const tab = await first.openTab({
      workspaceId: "ws-a",
      url: `${siteUrl}login`,
      openedBy: "user",
    });
    await evaluate(first, tab.browserId, "localStorage.setItem('token', 'xyz')");
    await first.closeTab(tab.browserId);
    await waitFor(() => first.openContextIds().length === 0);

    const reopened = await first.openTab({
      workspaceId: "ws-a",
      url: `${siteUrl}whoami`,
      openedBy: "user",
    });
    expect(first.getTab(reopened.browserId)!.info().title).toBe("signed in");
    expect(await evaluate(first, reopened.browserId, "localStorage.getItem('token')")).toBe("xyz");
    await first.shutdown();

    const second = createHost();
    const again = await second.openTab({
      workspaceId: "ws-a",
      url: `${siteUrl}whoami`,
      openedBy: "user",
    });
    expect(second.getTab(again.browserId)!.info().title).toBe("signed in");
    expect(await evaluate(second, again.browserId, "localStorage.getItem('token')")).toBe("xyz");
    const other = await second.openTab({
      workspaceId: "ws-b",
      url: `${siteUrl}whoami`,
      openedBy: "user",
    });
    expect(second.getTab(other.browserId)!.info().title).toBe("anonymous");
  });

  it("saves localStorage an origin wrote before its tab navigated away", async () => {
    const first = createHost({ saveDelayMs: 60_000, saveIntervalMs: 60_000 });
    const tab = await first.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    await first.saveWorkspaceStorage("ws");
    await evaluate(first, tab.browserId, "localStorage.setItem('late', 'write')");
    await first.getTab(tab.browserId)!.contents.loadURL(otherUrl);
    await first.shutdown();

    const second = createHost();
    const again = await second.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    expect(await evaluate(second, again.browserId, "localStorage.getItem('late')")).toBe("write");
  });

  it("saves a cookie set without a navigation on the periodic save", async () => {
    const first = createHost({ saveIntervalMs: 100 });
    const tab = await first.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    await evaluate(first, tab.browserId, "fetch('/login').then(() => true)");
    const file = join(paseoHome, "server-browser", "storage", "ws.json");
    await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes("s3cret"));
  });

  it("drops every tab when Chromium crashes and relaunches on the next tab", async () => {
    const host = createHost();
    await host.openTab({ workspaceId: "ws-a", url: siteUrl, openedBy: "agent" });
    await host.openTab({ workspaceId: "ws-b", url: siteUrl, openedBy: "agent" });
    process.kill(host.browserPid()!, "SIGKILL");
    await waitFor(() => host.listTabs().length === 0);

    const reopened = await host.openTab({ workspaceId: "ws-a", url: siteUrl, openedBy: "agent" });
    expect(await evaluate(host, reopened.browserId, "document.title")).toBe("Fixture");
  });

  it("clears a workspace's data and brings its tabs back under the same ids", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    await evaluate(host, tab.browserId, "localStorage.setItem('token', 'xyz')");

    await host.clearWorkspaceData("ws");

    expect(host.listTabs().map((info) => info.browserId)).toEqual([tab.browserId]);
    await waitFor(() => host.getTab(tab.browserId)?.currentUrl === siteUrl);
    expect(await evaluate(host, tab.browserId, "localStorage.getItem('token')")).toBeNull();
  });

  it("refuses a tab past the limit with a message the agent can act on", async () => {
    const host = createHost({ maxTabs: 1 });
    await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    await expect(
      host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" }),
    ).rejects.toThrow(/browser_close_tab/);
  });

  it("closes and resizes tabs for browser_close_tab and browser_resize", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    const execute = (command: Parameters<ServerBrowserHost["execute"]>[0]["command"]) =>
      host.execute({
        type: "browser.automation.execute.request",
        requestId: "r",
        workspaceId: "ws",
        command,
      });

    const resized = await execute({
      command: "resize",
      args: { browserId: tab.browserId, width: 390, height: 844 },
    });
    expect(resized.ok).toBe(true);
    expect(await evaluate(host, tab.browserId, "innerWidth")).toBe(390);

    const closed = await execute({ command: "close_tab", args: { browserId: tab.browserId } });
    expect(closed.ok).toBe(true);
    expect(host.listTabs()).toEqual([]);
  });

  it("applies viewer input batches in arrival order, even when they overlap", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    const at = { x: 0.1, y: 0.2 };
    for (let i = 0; i < 3; i++) {
      // A client sends the press and the release as separate requests; neither waits.
      await Promise.all([
        tab.dispatchInput([
          { kind: "mouse", action: "move", ...at, button: "none", clickCount: 0 },
          { kind: "mouse", action: "down", ...at, button: "left", clickCount: 1 },
        ]),
        tab.dispatchInput([{ kind: "mouse", action: "up", ...at, button: "left", clickCount: 1 }]),
      ]);
    }
    expect(await evaluate(host, tab.browserId, "document.getElementById('add').dataset.n")).toBe(
      "3",
    );
  });

  it("reports a title the page sets after it loads, unmarked, to tab lists and viewers", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    await waitFor(() => host.listTabs()[0]?.title === "Fixture");
    const seen: string[] = [];
    host.subscribe((tabs) => seen.push(tabs[0]?.title ?? ""));

    await evaluate(host, tab.browserId, 'document.title = "3 unread"');
    await waitFor(() => host.listTabs()[0]?.title === "3 unread");
    await waitFor(() => seen.includes("3 unread"));
    // A single-page app that replaces its <title> element.
    await evaluate(
      host,
      tab.browserId,
      'document.querySelector("title").remove(); document.head.append(Object.assign(document.createElement("title"), { textContent: "Inbox" }))',
    );
    await waitFor(() => host.listTabs()[0]?.title === "Inbox");
    expect(await evaluate(host, tab.browserId, "document.title")).toBe("Inbox");
  });

  it("opens a tab with no blank page behind it, and keeps Back in step with the history", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    const info = () => host.listTabs().find((entry) => entry.browserId === tab.browserId)!;
    expect(info()).toMatchObject({ url: siteUrl, canGoBack: false, canGoForward: false });
    expect(await evaluate(host, tab.browserId, "history.length")).toBe(1);

    await tab.contents.loadURL(otherUrl);
    await waitFor(() => info().canGoBack && info().url === otherUrl);
    tab.contents.goBack();
    await waitFor(() => info().url === siteUrl);
    await waitFor(() => !info().canGoBack && info().canGoForward);
    tab.contents.goBack();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(info()).toMatchObject({ url: siteUrl, canGoBack: false });
  });

  it("stops a page that is still loading", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    const info = () => host.listTabs().find((entry) => entry.browserId === tab.browserId)!;
    await tab.navigate(`${siteUrl}slow`);
    await waitFor(() => info().isLoading && info().url === `${siteUrl}slow`);

    await tab.stopLoading();
    await waitFor(() => !info().isLoading);
    expect(await evaluate(host, tab.browserId, "document.body.innerText")).toBe("slow page");
  });

  it("reports a page that failed to load, with Chromium's error, until a load succeeds", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    const info = () => host.listTabs().find((entry) => entry.browserId === tab.browserId)!;
    const refused = await closedPortUrl();

    await expect(tab.navigate(refused)).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
    // The error page commits after Page.navigate answers; the tab keeps the URL it tried.
    await waitFor(() => info().url === refused);
    expect(info().loadError).toEqual({ url: refused, errorText: "net::ERR_CONNECTION_REFUSED" });

    await tab.contents.loadURL(siteUrl);
    await waitFor(() => info().url === siteUrl && !info().loadError);

    // A load the page starts has no navigate answer. Chrome's error page names the error; the
    // headless shell's is empty, so the failure carries only its URL there.
    await evaluate(host, tab.browserId, `location.href = ${JSON.stringify(refused)}`);
    await waitFor(() => info().loadError?.url === refused && info().url === refused);
  });

  it("closes Chromium on shutdown", async () => {
    const host = createHost();
    await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    const pid = host.browserPid()!;
    await host.shutdown();
    expect(isRunning(pid)).toBe(false);
  });
});

/** A loopback URL nothing listens on (port 9 and friends are on Chromium's unsafe list). */
async function closedPortUrl(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/`;
}
