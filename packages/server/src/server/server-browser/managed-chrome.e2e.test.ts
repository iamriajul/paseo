import { execFile, spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveServerBrowserEngine } from "./bootstrap.js";
import { managedChromeHeadlessOnly } from "./engines.js";
import { ServerBrowserHost } from "./server-browser-host.js";
import { firstFrame, waitFor, watchVideo } from "./test-utils/viewers.js";

// Managed Chrome through the real engine on whatever host runs it. CI runs it on its macOS and
// Windows server-test runners, whose images ship Google Chrome; Linux has the fuller local suite
// (server-browser-engines.local.e2e.test.ts). It needs Google Chrome installed.

let paseoHome: string;
let site: http.Server;
let siteUrl: string;
const hosts: ServerBrowserHost[] = [];

beforeEach(async () => {
  paseoHome = mkdtempSync(join(tmpdir(), "managed-chrome-"));
  site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    // Repaints every frame, so the screencast and the tab capture always have frames to send.
    res.end(
      "<title>Fixture</title><body style='margin:0'><script>(function f(){document.body.style.background=" +
        "`hsl(${Date.now() % 360} 80% 50%)`;requestAnimationFrame(f)})()</script>",
    );
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  siteUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  await new Promise<void>((resolve) => site.close(() => resolve()));
  rmSync(paseoHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function createHost(): ServerBrowserHost {
  const host = new ServerBrowserHost({
    paseoHome,
    logger: pino({ level: "silent" }),
    isEnabled: () => true,
    // The setting Settings saves by default: Window, which a macOS or Windows host runs headless.
    getEngine: () => resolveServerBrowserEngine({ engine: "managed-chrome", chromeMode: "window" }),
    display: "xvfb",
  });
  hosts.push(host);
  return host;
}

interface HostProcess {
  pid: number;
  ppid: number;
  command: string;
}

/** Every process on the host, with its parent and command line. */
function listProcesses(): Promise<HostProcess[]> {
  const [file, args] =
    process.platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
          ],
        ]
      : ["ps", ["-A", "-o", "pid=,ppid=,command="]];
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      const processes: HostProcess[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
        if (match) {
          processes.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
        }
      }
      resolve(processes);
    });
  });
}

/** The browser process and everything it started (renderers, GPU, network, helpers). */
async function chromeTree(browserPid: number): Promise<HostProcess[]> {
  const processes = await listProcesses();
  const tree = new Set([browserPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of processes) {
      if (tree.has(entry.ppid) && !tree.has(entry.pid)) {
        tree.add(entry.pid);
        grew = true;
      }
    }
  }
  return processes.filter((entry) => tree.has(entry.pid));
}

/** Waits until none of these processes runs; a reused pid has another command line. */
async function waitForExit(processes: HostProcess[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let alive = processes;
  while (Date.now() < deadline) {
    const running = new Map((await listProcesses()).map((entry) => [entry.pid, entry.command]));
    alive = processes.filter((entry) => running.get(entry.pid) === entry.command);
    if (alive.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Chrome processes outlived it: ${alive.map((entry) => `${entry.pid} ${entry.command.slice(0, 160)}`).join("\n")}`,
  );
}

describe("Managed Chrome on this host", { timeout: 90_000 }, () => {
  it("streams a frame and H.264 from a tab, then closes it leaving no Chrome process", async () => {
    const host = createHost();
    const { browserId } = await host.openTab({
      workspaceId: "ws",
      url: siteUrl,
      openedBy: "agent",
    });
    const browserPid = host.browserPid()!;
    const tree = await chromeTree(browserPid);
    const browser = tree.find((entry) => entry.pid === browserPid)!;
    if (managedChromeHeadlessOnly()) {
      expect(browser.command).toContain("--headless=new");
      expect(browser.command).toContain("chrome-profile-headless");
    }
    const userAgent = await host
      .getTab(browserId)!
      .contents.executeJavaScript("navigator.userAgent");
    expect(userAgent).toMatch(/Chrome\/\d+\.0\.0\.0/);
    expect(userAgent).not.toContain("Headless");

    const frame = await firstFrame(host, browserId);
    expect(frame.jpeg.byteLength).toBeGreaterThan(0);

    const watched = await watchVideo(host, browserId, ["avc1.42E028"]);
    expect(watched?.codec).toBe("avc1.42E028");
    const { watch } = watched!;
    await waitFor(() => watch.chunks.length >= 10, 30_000);
    expect(watch.chunks[0]?.key).toBe(true);
    expect(watch.chunks.slice(1).some((chunk) => !chunk.key)).toBe(true);
    expect(watch.fellBack).toBe(false);
    watch.stop();

    await host.closeTab(browserId);
    expect(host.getTab(browserId)).toBeNull();
    await host.shutdown();
    await waitForExit(tree);
  });

  it("goes down with a killed daemon", async () => {
    // A stand-in daemon: starts Managed Chrome the way the daemon does, prints its pid, stays alive.
    const engines = new URL("./engines.ts", import.meta.url).href;
    const daemon = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const { startEngine } = await import(${JSON.stringify(engines)});
         const noop = () => {};
         const browser = await startEngine({
           config: { kind: "managed-chrome", chromeMode: "headless" },
           paseoHome: ${JSON.stringify(paseoHome)},
           noSandbox: false,
           events: { onEvent: noop, onTargetInfo: noop, onTargetDestroyed: noop, onExit: noop },
         });
         await browser.createTarget();
         console.log(browser.pid);
         setInterval(noop, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const browserPid = await new Promise<number>((resolve, reject) => {
      daemon.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      daemon.once("exit", () => reject(new Error("stand-in daemon exited before Chrome started")));
    });
    const tree = await chromeTree(browserPid);
    expect(tree.length).toBeGreaterThan(1);
    daemon.kill("SIGKILL");
    await waitForExit(tree);
  });
});
