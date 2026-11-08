import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CdpConnection, webSocketTransport } from "./cdp-connection.js";
import type { ServerBrowserEngineConfig } from "./engines.js";
import { ServerBrowserHost } from "./server-browser-host.js";

// Local-only: needs google-chrome and Xvfb on this machine. Managed Chrome always runs on its own
// Xvfb here, and the stand-in for a user's browser is a Chrome this file starts on a random port.

let paseoHome: string;
let site: http.Server;
let siteUrl: string;
const hosts: ServerBrowserHost[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  paseoHome = mkdtempSync(join(tmpdir(), "server-browser-engines-"));
  site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/login") res.setHeader("set-cookie", "sid=s3cret; HttpOnly; Path=/");
    if (req.url === "/whoami") {
      const signedIn = /sid=s3cret/.test(req.headers.cookie ?? "");
      res.end(`<title>${signedIn ? "signed in" : "anonymous"}</title>`);
      return;
    }
    res.end("<title>Fixture</title><p>fixture</p>");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  siteUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await new Promise<void>((resolve) => site.close(() => resolve()));
  rmSync(paseoHome, { recursive: true, force: true });
});

function createHost(engine: ServerBrowserEngineConfig): ServerBrowserHost {
  const host = new ServerBrowserHost({
    paseoHome,
    logger: pino({ level: "silent" }),
    isEnabled: () => true,
    getEngine: () => engine,
    display: "xvfb",
  });
  hosts.push(host);
  return host;
}

async function evaluate(host: ServerBrowserHost, browserId: string, script: string) {
  return host.getTab(browserId)!.contents.executeJavaScript(script);
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

function childPids(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function xvfbPids(): number[] {
  const pids: number[] = [];
  for (const pid of childPids(process.pid)) {
    try {
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "Xvfb") pids.push(pid);
    } catch {}
  }
  return pids;
}

async function firstFrame(host: ServerBrowserHost, browserId: string) {
  const tab = host.getTab(browserId)!;
  return new Promise<{ width: number; jpeg: Uint8Array }>((resolve) => {
    tab.screencast.addViewer(
      "test",
      {
        send: (frame) => resolve(frame),
        isCongested: () => false,
      },
      { maxWidth: 640, maxHeight: 400 },
    );
  });
}

describe("Managed Chrome", { timeout: 120_000 }, () => {
  it("runs real Chrome headed on a display, without automation tells", async () => {
    const host = createHost({ kind: "managed-chrome" });
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    const pid = host.browserPid()!;
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    expect(cmdline.some((arg) => arg.startsWith("--headless"))).toBe(false);
    expect(cmdline).not.toContain("--enable-automation");
    const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    expect(environment.some((entry) => /^DISPLAY=:\d+$/.test(entry))).toBe(true);
    expect(await evaluate(host, tab.browserId, "navigator.webdriver")).toBe(false);
    expect(await evaluate(host, tab.browserId, "navigator.userAgent")).not.toMatch(/Headless/);
    expect(await evaluate(host, tab.browserId, "document.visibilityState")).toBe("visible");
  });

  it("paints every tab, each in its own window", async () => {
    const host = createHost({ kind: "managed-chrome" });
    const a = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    const b = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    const [frameA, frameB] = await Promise.all([
      firstFrame(host, a.browserId),
      firstFrame(host, b.browserId),
    ]);
    expect(frameA.jpeg.length).toBeGreaterThan(0);
    expect(frameB.jpeg.length).toBeGreaterThan(0);
    expect(await evaluate(host, a.browserId, "document.visibilityState")).toBe("visible");
  });

  it("keeps cookies, localStorage and IndexedDB in its profile across a restart", async () => {
    const first = createHost({ kind: "managed-chrome" });
    const tab = await first.openTab({
      workspaceId: "ws",
      url: `${siteUrl}login`,
      openedBy: "user",
    });
    await evaluate(
      first,
      tab.browserId,
      `localStorage.setItem('token', 'xyz');
       new Promise((resolve, reject) => {
         const open = indexedDB.open('app', 1);
         open.onupgradeneeded = () => open.result.createObjectStore('kv');
         open.onsuccess = () => {
           const tx = open.result.transaction('kv', 'readwrite');
           tx.objectStore('kv').put('firebase-like-session', 'auth');
           tx.oncomplete = () => resolve(true);
           tx.onerror = () => reject(tx.error);
         };
       })`,
    );
    const firstPid = first.browserPid()!;
    await first.shutdown();
    expect(isRunning(firstPid)).toBe(false);

    const second = createHost({ kind: "managed-chrome" });
    const again = await second.openTab({
      workspaceId: "ws",
      url: `${siteUrl}whoami`,
      openedBy: "user",
    });
    expect(second.getTab(again.browserId)!.info().title).toBe("signed in");
    expect(await evaluate(second, again.browserId, "localStorage.getItem('token')")).toBe("xyz");
    expect(
      await evaluate(
        second,
        again.browserId,
        `new Promise((resolve) => {
           const open = indexedDB.open('app', 1);
           open.onsuccess = () => {
             const get = open.result.transaction('kv').objectStore('kv').get('auth');
             get.onsuccess = () => resolve(get.result);
           };
         })`,
      ),
    ).toBe("firebase-like-session");
  });

  it("shares one profile across workspaces and has no workspace data to clear", async () => {
    const host = createHost({ kind: "managed-chrome" });
    await host.openTab({ workspaceId: "ws-a", url: `${siteUrl}login`, openedBy: "user" });
    const b = await host.openTab({
      workspaceId: "ws-b",
      url: `${siteUrl}whoami`,
      openedBy: "user",
    });
    expect(host.getTab(b.browserId)!.info().title).toBe("signed in");
    expect(host.status().engine).toEqual({ kind: "managed-chrome", sharedStorage: true });
    await expect(host.clearWorkspaceData("ws-a")).rejects.toThrow(/one browser profile/);
  });

  it("stops the Xvfb it started once Chrome exits", async () => {
    const host = createHost({ kind: "managed-chrome" });
    const before = new Set(xvfbPids());
    await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    const started = xvfbPids().filter((pid) => !before.has(pid));
    expect(started).toHaveLength(1);
    await host.shutdown();
    await waitFor(() => !isRunning(started[0]!) || readProcState(started[0]!) === "Z");
  });
});

function readProcState(pid: number): string {
  try {
    return /State:\s+(\w)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? "";
  } catch {
    return "";
  }
}

/** A browser that is not Paseo's: real Chrome on a random port with one tab of its own. */
async function startUsersChrome(options: { display?: string } = {}): Promise<{
  pid: number;
  url: string;
  cdp: CdpConnection;
  ownTabId: string;
}> {
  const profile = mkdtempSync(join(tmpdir(), "users-chrome-"));
  const child = spawn(
    "google-chrome",
    [
      ...(options.display ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      `${siteUrl}?users-own-tab`,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...(options.display ? { DISPLAY: options.display } : {}) },
    },
  );
  children.push(child);
  child.once("exit", () => rmSync(profile, { recursive: true, force: true }));
  const webSocketUrl = await new Promise<string>((resolve, reject) => {
    let text = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      text += chunk;
      const match = /DevTools listening on (ws:\S+)/.exec(text);
      if (match) resolve(match[1]!);
    });
    child.once("exit", () => reject(new Error(`Chrome exited: ${text}`)));
  });
  const cdp = new CdpConnection(await webSocketTransport(webSocketUrl));
  let ownTabId = "";
  for (let attempt = 0; attempt < 50 && !ownTabId; attempt++) {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    ownTabId = targetInfos.find((info) => info.url.includes("users-own-tab"))?.targetId ?? "";
    if (!ownTabId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const port = new URL(webSocketUrl).port;
  return { pid: child.pid!, url: `http://127.0.0.1:${port}`, cdp, ownTabId };
}

async function pageTargets(cdp: CdpConnection) {
  const { targetInfos } = (await cdp.send("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  };
  return targetInfos.filter((info) => info.type === "page");
}

describe("Existing browser", { timeout: 120_000 }, () => {
  it("opens tabs beside the owner's, leaves theirs alone, and never closes their browser", async () => {
    const users = await startUsersChrome();
    expect(users.ownTabId).not.toBe("");
    const host = createHost({ kind: "existing", cdpUrl: users.url });

    const tab = await host.openTab({
      workspaceId: "ws",
      url: `${siteUrl}?paseo`,
      openedBy: "agent",
    });
    expect(host.listTabs().map((info) => info.url)).toEqual([`${siteUrl}?paseo`]);
    expect(host.browserPid()).toBeUndefined();

    await host.closeTab(tab.browserId);
    await host.openTab({ workspaceId: "ws", url: `${siteUrl}?paseo-2`, openedBy: "agent" });
    await host.shutdown();

    expect(isRunning(users.pid)).toBe(true);
    const remaining = await pageTargets(users.cdp);
    expect(remaining.map((info) => info.targetId)).toEqual([users.ownTabId]);
    expect(remaining[0]!.url).toContain("users-own-tab");
    users.cdp.disconnect();
  });

  it("leaves the owner's window focused when it opens a tab", async () => {
    const xvfb = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
      {
        stdio: ["ignore", "ignore", "ignore", "pipe"],
      },
    );
    children.push(xvfb);
    const display = await new Promise<string>((resolve) => {
      (xvfb.stdio[3] as NodeJS.ReadableStream).setEncoding("utf8");
      (xvfb.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: string) =>
        resolve(`:${chunk.trim()}`),
      );
    });
    const users = await startUsersChrome({ display });
    const { sessionId } = (await users.cdp.send("Target.attachToTarget", {
      targetId: users.ownTabId,
      flatten: true,
    })) as { sessionId: string };
    const ownerFocused = async () =>
      (
        (await users.cdp.send(
          "Runtime.evaluate",
          { expression: "document.hasFocus()", returnByValue: true },
          sessionId,
        )) as { result: { value: boolean } }
      ).result.value;
    for (let attempt = 0; attempt < 50 && !(await ownerFocused()); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await ownerFocused()).toBe(true);

    const host = createHost({ kind: "existing", cdpUrl: users.url });
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });

    expect(await ownerFocused()).toBe(true);
    expect(await evaluate(host, tab.browserId, "document.visibilityState")).toBe("visible");
    users.cdp.disconnect();
  });

  it("ignores what happens in the owner's tabs", async () => {
    const users = await startUsersChrome();
    const host = createHost({ kind: "existing", cdpUrl: users.url });
    await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    const { sessionId } = (await users.cdp.send("Target.attachToTarget", {
      targetId: users.ownTabId,
      flatten: true,
    })) as { sessionId: string };
    await users.cdp.send("Page.navigate", { url: `${siteUrl}whoami` }, sessionId);
    await users.cdp.send("Target.closeTarget", { targetId: users.ownTabId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(host.listTabs()).toHaveLength(1);
    expect(host.listTabs()[0]!.url).toBe(siteUrl);
    users.cdp.disconnect();
  });

  it("says plainly when no browser answers at the URL", async () => {
    const host = createHost({ kind: "existing", cdpUrl: "http://127.0.0.1:9" });
    await expect(
      host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" }),
    ).rejects.toThrow(/No browser answers at http:\/\/127.0.0.1:9/);
    expect(host.status().unavailableReason).toMatch(/No browser answers/);
  });
});
