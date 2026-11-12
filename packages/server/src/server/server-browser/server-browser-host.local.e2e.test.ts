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
const heldResponses = new Set<http.ServerResponse>();

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
    if (req.url === "/long") {
      res.end("<title>Long</title><div style='height:5000px'>long page</div>");
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost");
    if (path.pathname === "/hanging-image") {
      // Never answered: the page's load event never fires.
      heldResponses.add(res);
      res.on("close", () => heldResponses.delete(res));
      return;
    }
    if (path.pathname === "/hanging") {
      res.end(
        `<title>Hanging</title><button>Loaded DOM</button><img src="/hanging-image${path.search}">`,
      );
      return;
    }
    if (path.pathname === "/redirect") {
      res.end(`<script>location.replace("/landing")</script><img src="/hanging-image?redirect">`);
      return;
    }
    if (path.pathname === "/slow-document") {
      const ms = Number(path.searchParams.get("ms") ?? 0);
      setTimeout(() => res.end("<title>Slow document</title>"), ms);
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
  for (const response of heldResponses) response.destroy();
  site.closeAllConnections();
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

  it("suspends an idle tab, then reloads it at its URL and scroll when used", async () => {
    const host = createHost({ contextIdleMs: 200, browserIdleMs: 200 });
    const tab = await host.openTab({ workspaceId: "ws", url: `${siteUrl}long`, openedBy: "agent" });
    const pid = host.browserPid()!;
    await evaluate(host, tab.browserId, "window.scrollTo(0, 1200)");

    await host.suspendTab(tab.browserId);

    expect(host.listTabs()).toEqual([
      expect.objectContaining({ url: `${siteUrl}long`, title: "Long", suspended: true }),
    ]);
    const frame = tab.currentStillFrame!;
    expect([frame.jpeg[0], frame.jpeg[1]]).toEqual([0xff, 0xd8]);
    expect(frame).toMatchObject({ width: 1280, height: 800 });
    // The only tab gone, the workspace's context and then Chromium go too.
    await waitFor(() => !isRunning(pid));

    const response = await host.execute({
      type: "browser.automation.execute.request",
      requestId: "r",
      workspaceId: "ws",
      command: { command: "evaluate", args: { browserId: tab.browserId, function: "() => 1" } },
    });

    expect(response.notice).toMatch(/suspended it to free memory/);
    expect(tab.isSuspended).toBe(false);
    expect(await evaluate(host, tab.browserId, "[location.href, window.scrollY]")).toEqual([
      `${siteUrl}long`,
      1200,
    ]);
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
    await first.getTab(tab.browserId)!.contents.loadDocument(otherUrl);
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

  it("refuses a tab past the limit, when every tab is watched, with a message the agent can act on", async () => {
    const host = createHost({ maxTabs: 1 });
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    tab.screencast.addViewer(
      "v",
      { send: () => {}, isCongested: () => false },
      {
        maxWidth: 640,
        maxHeight: 400,
      },
    );
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

    await tab.contents.loadDocument(otherUrl);
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
    // The document commits on its first bytes; the parser reaches the paragraph after that.
    let shown: unknown = null;
    while (shown !== "slow page") {
      shown = await evaluate(host, tab.browserId, "document.body?.innerText ?? null");
    }

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

    await tab.contents.loadDocument(siteUrl);
    await waitFor(() => info().url === siteUrl && !info().loadError);

    // A load the page starts has no navigate answer. Chrome's error page names the error; the
    // headless shell's is empty, so the failure carries only its URL there.
    await evaluate(host, tab.browserId, `location.href = ${JSON.stringify(refused)}`);
    await waitFor(() => info().loadError?.url === refused && info().url === refused);
  });

  it("gives the logs panel the console after a cursor, through the 200-line cap", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    await evaluate(host, tab.browserId, 'console.log("first"); console.warn("second")');
    await waitFor(() => tab.consoleSince().length === 2);
    const [first, second] = tab.consoleSince();
    expect(first).toMatchObject({ seq: 1, level: "log", message: "first" });
    expect(second).toMatchObject({ seq: 2, level: "warning", message: "second" });
    expect(tab.consoleSince(1).map((entry) => entry.message)).toEqual(["second"]);

    await evaluate(host, tab.browserId, 'for (let i = 0; i < 250; i++) console.log("line " + i)');
    await waitFor(() => tab.consoleSince(2).at(-1)?.message === "line 249");
    const kept = tab.consoleSince();
    expect(kept).toHaveLength(200);
    expect(kept[0]).toMatchObject({ seq: 53, message: "line 50" });
    expect(tab.consoleSince(251).map((entry) => entry.message)).toEqual(["line 249"]);
  });

  it("adopts the pages a tab opens as tabs of its workspace, and drops them when they close", async () => {
    const host = createHost();
    const opener = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    await opener.setViewport({ width: 900, height: 700, mobile: false });

    await evaluate(host, opener.browserId, `window.open(${JSON.stringify(otherUrl)}); 1`);
    await evaluate(
      host,
      opener.browserId,
      `Object.assign(document.createElement("a"), { href: ${JSON.stringify(`${otherUrl}?noopener`)}, target: "_blank", rel: "noopener" }).click(); 1`,
    );
    const loadedPopups = () => host.listTabs().filter(isOtherPage).length === 2;
    await waitFor(loadedPopups);
    const popups = host.listTabs().filter((tab) => tab.browserId !== opener.browserId);
    for (const popup of popups) {
      expect(popup).toMatchObject({
        workspaceId: "ws",
        openerBrowserId: opener.browserId,
        openedBy: "user",
        viewport: { width: 900, height: 700 },
      });
    }
    expect(popups.map((popup) => popup.url).sort()).toEqual([otherUrl, `${otherUrl}?noopener`]);

    await evaluate(host, popups[0]!.browserId, "window.close()").catch(() => undefined);
    await waitFor(() => host.listTabs().length === 2);
  });

  it("closes a popup past the tab limit and says so in the opener's console", async () => {
    const host = createHost({ maxTabs: 1 });
    const opener = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    await evaluate(host, opener.browserId, `window.open(${JSON.stringify(otherUrl)}); 1`);
    const saidClosed = () => opener.consoleSince().some(isPopupClosedNote);
    await waitFor(saidClosed);
    expect(host.listTabs()).toHaveLength(1);
  });

  it("holds a dialog for a watching viewer to answer, and accepts it when nobody watches", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    const info = () => host.listTabs().find((entry) => entry.browserId === tab.browserId)!;
    tab.screencast.addViewer(
      "viewer",
      { send: () => {}, isCongested: () => false },
      {
        maxWidth: 1280,
        maxHeight: 800,
      },
    );

    // A prompt from a click: the click itself gets no answer until the dialog closes.
    const answered = evaluate(host, tab.browserId, 'window.__answer = prompt("Name?", "Ada"); 1');
    await waitFor(() => info().dialog?.type === "prompt");
    expect(info().dialog).toMatchObject({ message: "Name?", defaultPrompt: "Ada" });
    await expect(tab.dispatchInput([{ kind: "text", text: "x" }])).rejects.toThrow(
      /prompt dialog is open on this page/,
    );
    await tab.answerDialog({ dialogId: info().dialog!.id, accept: true, promptText: "Grace" });
    await answered;
    expect(info().dialog).toBeUndefined();
    expect(await evaluate(host, tab.browserId, "window.__answer")).toBe("Grace");
    await expect(tab.answerDialog({ dialogId: "1", accept: true })).rejects.toThrow(
      /already answered/,
    );

    // The last viewer leaving accepts what is still open.
    const confirmed = evaluate(host, tab.browserId, 'window.__ok = confirm("Sure?"); 1');
    await waitFor(() => info().dialog?.type === "confirm");
    tab.screencast.removeViewer("viewer");
    await confirmed;
    expect(await evaluate(host, tab.browserId, "window.__ok")).toBe(true);

    // With nobody watching, a dialog never waits.
    await evaluate(host, tab.browserId, 'alert("hi"); 1');
    expect(info().dialog).toBeUndefined();
    expect(tab.consoleSince().map((entry) => entry.message)).toContain("Dialog auto-accepted: hi");
  });

  it("asks a watching viewer for the files a page's file input wants, and sets them", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    const info = () => host.listTabs().find((entry) => entry.browserId === tab.browserId)!;
    tab.screencast.addViewer(
      "viewer",
      { send: () => {}, isCongested: () => false },
      {
        maxWidth: 1280,
        maxHeight: 800,
      },
    );
    await evaluate(
      host,
      tab.browserId,
      `document.body.innerHTML = "<input id=f type=file multiple style='position:fixed;inset:0;width:100vw;height:100vh'>"; 1`,
    );
    const click = async () => {
      await tab.dispatchInput([
        { kind: "mouse", action: "down", x: 0.5, y: 0.5, button: "left", clickCount: 1 },
        { kind: "mouse", action: "up", x: 0.5, y: 0.5, button: "left", clickCount: 1 },
      ]);
    };

    await click();
    await waitFor(() => info().fileChooser?.multiple === true);
    const hello = Buffer.from("hello from the phone").toString("base64");
    await host.answerFileChooser(tab.browserId, info().fileChooser!.id, [
      { name: "notes.txt", dataBase64: hello },
      { name: "photo.png", dataBase64: hello },
    ]);
    expect(info().fileChooser).toBeUndefined();
    expect(
      await evaluate(
        host,
        tab.browserId,
        "(async () => { const f = document.getElementById('f').files; return [f.length, f[0].name, await f[0].text()].join('|'); })()",
      ),
    ).toBe("2|notes.txt|hello from the phone");

    // Cancelling leaves the input as it was.
    await click();
    await waitFor(() => info().fileChooser !== undefined);
    await host.answerFileChooser(tab.browserId, info().fileChooser!.id, []);
    expect(await evaluate(host, tab.browserId, "document.getElementById('f').files.length")).toBe(
      2,
    );
  });

  it("answers agent tools on a page that is still loading, inside the broker's 15 s", async () => {
    const host = createHost();
    let requestId = 0;
    const run = async (command: string, args: Record<string, unknown>) => {
      const startedAt = Date.now();
      const response = await host.execute({
        type: "browser.automation.execute.request",
        requestId: String(++requestId),
        workspaceId: "ws",
        command: { command, args } as never,
      });
      return { response, elapsedMs: Date.now() - startedAt };
    };
    const expectOk = async (
      command: string,
      args: Record<string, unknown>,
      budgetMs: number,
    ): Promise<Record<string, unknown>> => {
      const call = await run(command, args);
      expect(call.response, command).toMatchObject({ ok: true });
      expect(call.elapsedMs, `${command} took ${call.elapsedMs} ms`).toBeLessThan(budgetMs);
      return (call.response as { result: Record<string, unknown> }).result;
    };

    const created = await expectOk("new_tab", { url: `${siteUrl}hanging?first` }, 10_000);
    const browserId = created.browserId as string;
    const snapshot = await expectOk("snapshot", { browserId }, 5_000);
    expect(snapshot.snapshot).toContain("Loaded DOM");
    await expectOk("evaluate", { browserId, function: "() => document.title" }, 5_000);
    await expectOk("wait", { browserId, text: "Loaded DOM" }, 5_000);
    await expectOk("screenshot", { browserId }, 7_000);
    await expectOk("navigate", { browserId, url: `${siteUrl}hanging?second` }, 5_000);

    // A script redirect replaces the navigation; the replacement settles it.
    await expectOk("navigate", { browserId, url: `${siteUrl}redirect` }, 5_000);
    await expectOk("wait", { browserId, url: "/landing" }, 5_000);

    // A document the server answers after 14 s: navigate says what to do next before the broker
    // gives up. Chromium runs nothing on the page until that document commits, 4 s later.
    const slow = await run("navigate", { browserId, url: `${siteUrl}slow-document?ms=14000` });
    expect(slow.response).toMatchObject({
      ok: false,
      error: { code: "browser_timeout", message: expect.stringMatching(/still loading/) },
    });
    expect(slow.elapsedMs).toBeLessThan(15_000);
    await expectOk("evaluate", { browserId, function: "() => location.pathname" }, 12_000);
    await expectOk("wait", { browserId, url: "slow-document", timeoutMs: 10_000 }, 12_000);

    // A script still awaiting when the page navigates fails, and says so.
    const across = await run("evaluate", {
      browserId,
      function:
        "() => { setTimeout(() => { location.href = '/landing?after-script'; }, 100); return new Promise(() => {}); }",
    });
    expect(across.response).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/navigated/) },
    });
    expect(across.elapsedMs).toBeLessThan(5_000);

    await expectOk("navigate", { browserId, url: `${siteUrl}slow-document?ms=6000` }, 10_000);
    // Reload answers at once; the script runs once the reloaded document commits, 6 s later.
    await expectOk("reload", { browserId }, 3_000);
    await expectOk("evaluate", { browserId, function: "() => 1" }, 9_000);

    // A document that takes longer than any budget: script calls fail inside the broker's 15 s,
    // say what to do next, and the tab still navigates elsewhere.
    await run("navigate", { browserId, url: `${siteUrl}slow-document?ms=60000` });
    const pending = await run("evaluate", { browserId, function: "() => 1" });
    expect(pending.response).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/still loading.*browser_wait/) },
    });
    expect(pending.elapsedMs).toBeLessThan(15_000);
    await expectOk("navigate", { browserId, url: `${siteUrl}landing` }, 5_000);
    await expectOk("evaluate", { browserId, function: "() => location.pathname" }, 3_000);

    await expectOk("close_tab", { browserId }, 5_000);
  }, 120_000);
  it("records the loopback ports a page's documents, fetches and WebSockets use", async () => {
    const api = http.createServer((_req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      res.end("{}");
    });
    // Accepts the upgrade request and stops there: the tab only has to have opened the socket.
    const socketServer = http.createServer();
    socketServer.on("upgrade", (_req, socket) => socket.destroy());
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => socketServer.listen(0, "127.0.0.1", resolve));
    const portOf = (server: http.Server) => (server.address() as { port: number }).port;
    try {
      const host = createHost();
      const tab = await host.openTab({ workspaceId: "ws-a", url: siteUrl, openedBy: "user" });
      await evaluate(
        host,
        tab.browserId,
        `fetch("http://localhost:${portOf(api)}/api").then((r) => r.text()).then(() => {
           new WebSocket("ws://127.0.0.1:${portOf(socketServer)}/hmr");
           return fetch("https://example.invalid/").catch(() => null);
         })`,
      );
      const sitePort = Number(new URL(siteUrl).port);
      const expected = [sitePort, portOf(api), portOf(socketServer)].sort((a, b) => a - b);
      await waitFor(
        () => host.getTab(tab.browserId)!.observedLoopbackPorts().join() === expected.join(),
      );
    } finally {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    }
  });

  it("reports a page whose renderer crashed, fails its commands fast, and reloads it", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws-a", url: siteUrl, openedBy: "user" });
    const live = host.getTab(tab.browserId)!;
    // Chromium never answers the command that crashed the page; the crash must end it.
    const crash = live.contents.sendDebugCommand("Page.crash");
    await expect(crash).rejects.toThrow(/crashed/);
    expect(live.info().crashed).toBe(true);
    expect(host.listTabs().map((info) => info.browserId)).toContain(tab.browserId);
    // A command the dead renderer would handle fails at once instead of hanging.
    await expect(evaluate(host, tab.browserId, "1 + 1")).rejects.toThrow(/Reload the tab/);

    await live.reload();
    await waitFor(() => live.info().crashed !== true);
    let title = "";
    for (let attempt = 0; attempt < 40 && title !== "Fixture"; attempt++) {
      title = String(await evaluate(host, tab.browserId, "document.title"));
      if (title !== "Fixture") await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(title).toBe("Fixture");
    // Viewer input works on the reloaded page.
    const at = { x: 0.1, y: 0.2 };
    await live.dispatchInput([
      { kind: "mouse", action: "move", ...at, button: "none", clickCount: 0 },
      { kind: "mouse", action: "down", ...at, button: "left", clickCount: 1 },
      { kind: "mouse", action: "up", ...at, button: "left", clickCount: 1 },
    ]);
    expect(await evaluate(host, tab.browserId, "document.getElementById('add').dataset.n")).toBe(
      "1",
    );
  });

  it("gives a Mac viewer's Cmd editing keys their Ctrl meaning on a Linux host", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    await evaluate(
      host,
      tab.browserId,
      "document.body.insertAdjacentHTML('beforeend', '<input id=field value=hello>'); document.getElementById('field').focus()",
    );
    const cmd = (key: string, action: "down" | "up") => ({
      kind: "key" as const,
      action,
      key,
      code: `Key${key.toUpperCase()}`,
      keyCode: key.toUpperCase().charCodeAt(0),
      modifiers: ["Meta" as const],
    });
    // Cmd+A selects the field's text; typing then replaces it.
    await tab.dispatchInput([cmd("a", "down"), cmd("a", "up")]);
    await tab.dispatchInput([{ kind: "text", text: "x" }]);
    expect(await evaluate(host, tab.browserId, "document.getElementById('field').value")).toBe("x");
    // Cmd+Z undoes the typing.
    await tab.dispatchInput([cmd("z", "down"), cmd("z", "up")]);
    expect(await evaluate(host, tab.browserId, "document.getElementById('field').value")).toBe(
      "hello",
    );
  });

  it("reads the page's selection for a viewer to copy, from a field or the document", async () => {
    const host = createHost();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    const live = host.getTab(tab.browserId)!;
    expect(await live.readSelection()).toBe("");
    await evaluate(
      host,
      tab.browserId,
      "document.body.insertAdjacentHTML('beforeend', '<input id=field value=\"hello world\">'); const f = document.getElementById('field'); f.focus(); f.setSelectionRange(6, 11)",
    );
    expect(await live.readSelection()).toBe("world");
    await evaluate(
      host,
      tab.browserId,
      "document.activeElement.blur(); getSelection().selectAllChildren(document.querySelector('p'))",
    );
    expect(await live.readSelection()).toBe("fixture page");
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

function isOtherPage(tab: { title: string }): boolean {
  return tab.title === "Other";
}

function isPopupClosedNote(entry: { message: string }): boolean {
  return /popup was closed/.test(entry.message);
}
