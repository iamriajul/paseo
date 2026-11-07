import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerBrowserHost, type ServerBrowserLimits } from "./server-browser-host.js";

// Local-only: needs a Chromium on this machine (`npx playwright install chromium-headless-shell`).

let paseoHome: string;
let site: http.Server;
let siteUrl: string;
const hosts: ServerBrowserHost[] = [];

beforeEach(async () => {
  paseoHome = mkdtempSync(join(tmpdir(), "server-browser-host-"));
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      "<title>Fixture</title><p>fixture page</p>" +
        "<button id=add style='position:fixed;left:0;top:0;width:400px;height:400px' " +
        "onclick='this.dataset.n=(+this.dataset.n||0)+1'>add</button>",
    );
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  siteUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  await new Promise<void>((resolve) => site.close(() => resolve()));
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
  it("starts Chromium on the first tab and stops it once the workspace has no tabs", async () => {
    const host = createHost({ browserIdleMs: 300 });
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    expect(host.listTabs().map((info) => info.title)).toEqual(["Fixture"]);
    const pid = host.browserPid("ws")!;
    expect(isRunning(pid)).toBe(true);

    await host.closeTab(tab.browserId);
    await waitFor(() => !isRunning(pid));
  });

  it("drops a crashed browser's tabs and relaunches on the next tab", async () => {
    const host = createHost();
    await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    process.kill(host.browserPid("ws")!, "SIGKILL");
    await waitFor(() => host.listTabs().length === 0);

    const reopened = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    expect(await evaluate(host, reopened.browserId, "document.title")).toBe("Fixture");
  });

  it("keeps a workspace's cookies and localStorage across browser restarts, apart from other workspaces", async () => {
    const first = createHost();
    const tab = await first.openTab({ workspaceId: "ws-a", url: siteUrl, openedBy: "user" });
    await evaluate(
      first,
      tab.browserId,
      "document.cookie = 'session=abc; max-age=3600'; localStorage.setItem('token', 'xyz')",
    );
    await first.shutdown();

    const second = createHost();
    const again = await second.openTab({ workspaceId: "ws-a", url: siteUrl, openedBy: "user" });
    expect(await evaluate(second, again.browserId, "document.cookie")).toBe("session=abc");
    expect(await evaluate(second, again.browserId, "localStorage.getItem('token')")).toBe("xyz");

    const other = await second.openTab({ workspaceId: "ws-b", url: siteUrl, openedBy: "user" });
    expect(await evaluate(second, other.browserId, "document.cookie")).toBe("");
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

  it("closes Chromium on shutdown", async () => {
    const host = createHost();
    await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    const pid = host.browserPid("ws")!;
    await host.shutdown();
    expect(isRunning(pid)).toBe(false);
  });
});
