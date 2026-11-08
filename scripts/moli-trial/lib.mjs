// Shared harness for the Moli trial: browser launchers, a tiny CDP client, process-tree memory.
// Every browser starts in its own process group (detached) and is killed as a group.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";

export const MOLI_BIN = process.env.MOLI_BIN ?? "/tmp/moli-bin/moli";
export const HEADLESS_SHELL = join(
  homedir(),
  ".cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell",
);
export const GOOGLE_CHROME = "/usr/bin/google-chrome";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  "--password-store=basic",
  "--use-mock-keychain",
  "--hide-scrollbars",
  "--mute-audio",
  "--no-sandbox",
];

/**
 * engine: "moli" | "shell" | "chrome" | "chrome-headed"
 * Returns { engine, pid, wsUrl, httpBase, kill(), profileDir }.
 */
export async function launch(
  engine,
  { port, profileDir, moliArgs = [], extraArgs = [], env } = {},
) {
  port ??= 9400 + Math.floor(Math.random() * 500);
  const ownProfile = !profileDir;
  profileDir ??= mkdtempSync(join(tmpdir(), `moli-trial-${engine}-`));
  let cmd;
  let args;
  if (engine === "moli") {
    cmd = MOLI_BIN;
    args = ["serve", "--host", "127.0.0.1", "--port", String(port), "-P", profileDir, ...moliArgs];
  } else {
    cmd = engine === "shell" ? HEADLESS_SHELL : GOOGLE_CHROME;
    const headless = engine === "chrome" ? ["--headless=new"] : [];
    args = [
      ...headless,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      ...CHROME_ARGS,
      ...extraArgs,
      "about:blank",
    ];
  }
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    if (stderr.length < 20000) stderr += c;
  });
  const httpBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  let version;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${engine} exited: ${stderr.slice(-2000)}`);
    try {
      version = await (await fetch(`${httpBase}/json/version`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!version) {
    killGroup(child.pid);
    throw new Error(`${engine} did not come up: ${stderr.slice(-2000)}`);
  }
  const kill = async () => {
    killGroup(child.pid);
    await sleep(300);
    if (ownProfile) rmSync(profileDir, { recursive: true, force: true });
  };
  return {
    engine,
    pid: child.pid,
    wsUrl: version.webSocketDebuggerUrl,
    httpBase,
    version,
    kill,
    profileDir,
    stderr: () => stderr,
  };
}

export function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

/** Minimal CDP client over WebSocket with flatten sessions. */
export class Cdp {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", (e) => rej(new Error(`ws error ${e.message ?? ""}`)));
    });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.events = [];
    ws.addEventListener("message", (m) => this.receive(m));
  }
  receive(m) {
    const msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString());
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error)
        p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { cdp: msg.error }));
      else p.resolve(msg.result ?? {});
    } else {
      this.events.push(msg);
      if (this.events.length > 5000) this.events.splice(0, 1000);
      for (const l of this.listeners) l(msg);
    }
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  waitFor(pred, timeoutMs = 10000) {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off();
        reject(new Error("event timeout"));
      }, timeoutMs);
      const off = this.on((m) => {
        if (pred(m)) {
          clearTimeout(t);
          off();
          resolve(m);
        }
      });
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/** Opens a page target (optionally in a context) and attaches with flatten. */
export async function openPage(cdp, { browserContextId, url = "about:blank" } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", {
    url,
    ...(browserContextId ? { browserContextId } : {}),
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, sessionId };
}

export async function navigateAndWait(cdp, sessionId, url, timeoutMs = 20000) {
  const start = cdp.events.length;
  await cdp.send("Page.navigate", { url }, sessionId, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      cdp.events
        .slice(start)
        .some((e) => e.sessionId === sessionId && e.method === "Page.loadEventFired")
    )
      return true;
    await sleep(50);
  }
  return false;
}

export async function evaluate(cdp, sessionId, expression, timeoutMs = 15000) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
    timeoutMs,
  );
  if (r.exceptionDetails)
    throw new Error(`eval threw: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
  return r.result?.value;
}

// ---- process-tree memory ----
function children(pid) {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid === pid) out.push(Number(d));
    } catch {}
  }
  return out;
}
export function processTree(pid) {
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...children(all[i]));
  return all;
}
/** Sum RSS and PSS (kB → MB) of a process and all its descendants, plus CPU ticks. */
export function treeMemory(pid) {
  let rss = 0;
  let pss = 0;
  let ticks = 0;
  const pids = processTree(pid);
  for (const p of pids) {
    try {
      const roll = readFileSync(`/proc/${p}/smaps_rollup`, "utf8");
      rss += Number(/^Rss:\s+(\d+)/m.exec(roll)?.[1] ?? 0);
      pss += Number(/^Pss:\s+(\d+)/m.exec(roll)?.[1] ?? 0);
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ticks += Number(f[11]) + Number(f[12]);
    } catch {}
  }
  return { procs: pids.length, rssMB: rss / 1024, pssMB: pss / 1024, ticks };
}
export function treeTicks(pid) {
  return treeMemory(pid).ticks;
}

// ---- fixture server ----
export async function serveFixtures(dir, port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = join(dir, file);
    if (!existsSync(path)) {
      res.statusCode = 404;
      return res.end("nf");
    }
    const ext = path.split(".").pop();
    const types = {
      html: "text/html",
      js: "text/javascript",
      css: "text/css",
      png: "image/png",
      svg: "image/svg+xml",
    };
    res.setHeader("content-type", types[ext] ?? "application/octet-stream");
    res.end(readFileSync(path));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
