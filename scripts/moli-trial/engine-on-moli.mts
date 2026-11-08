// Runs Paseo's real ServerBrowserHost (vendored automation engine, tabs, screencast hub, input)
// against Moli through the host's `launch` injection point, without editing server-browser code.
// The bridge turns Moli's CDP WebSocket into the NUL-framed pipe streams CdpConnection expects.
// Usage: npx tsx scripts/moli-trial/engine-on-moli.mts [moli|shell]   (shell = control run)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { CdpConnection } from "../../packages/server/src/server/server-browser/cdp-connection.js";
import { ServerBrowserHost } from "../../packages/server/src/server/server-browser/server-browser-host.js";

const MOLI_BIN = process.env.MOLI_BIN ?? "/tmp/moli-bin/moli";
const engine = process.argv[2] ?? "moli";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launchMoli(options: { userDataDir: string }) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const child = spawn(
    MOLI_BIN,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-P",
      options.userDataDir,
      "--layout",
      "-r",
      "--screencast-interval-ms",
      "33",
    ],
    { detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let wsUrl = "";
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      wsUrl = (
        (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
          webSocketDebuggerUrl: string;
        }
      ).webSocketDebuggerUrl;
    } catch {
      await sleep(100);
    }
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  let buffer = "";
  toBrowser.setEncoding("utf8");
  toBrowser.on("data", (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf("\0");
    while (end !== -1) {
      ws.send(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\0");
    }
  });
  ws.addEventListener("message", (m) =>
    fromBrowser.write(
      `${typeof m.data === "string" ? m.data : Buffer.from(m.data as ArrayBuffer).toString()}\0`,
    ),
  );
  ws.addEventListener("close", () => fromBrowser.end());
  child.once("exit", () => ws.close());
  // Mirror Chromium's pipe semantics: the browser dies with its connection.
  const connection = new CdpConnection(toBrowser, fromBrowser);
  connection.on("close", () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  });
  return { process: child, connection, sandboxed: false };
}

interface Result {
  name: string;
  ok: boolean;
  note: string;
}
const results: Result[] = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    results.push({ name, ok: true, note: (await fn()) ?? "" });
  } catch (error) {
    results.push({ name, ok: false, note: String((error as Error).message).slice(0, 300) });
  }
}

const site = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url?.startsWith("/form")) {
    res.end(
      "<title>Form</title><label>Email <input name=email></label><label>Password <input type=password name=pw></label>" +
        "<button onclick=\"document.body.dataset.sent=document.querySelector('[name=email]').value\">Sign in</button>" +
        "<select aria-label=Plan><option>free</option><option>pro</option></select>",
    );
    return;
  }
  res.end(
    "<title>Fixture</title><p>fixture page</p><a href='/form'>Go to form</a>" +
      "<button id=add style='position:fixed;left:0;top:200px;width:400px;height:200px' " +
      "onclick='this.dataset.n=(+this.dataset.n||0)+1'>add</button><div style='height:3000px'></div>",
  );
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
const paseoHome = mkdtempSync(join(tmpdir(), "moli-engine-"));

const makeHost = () =>
  new ServerBrowserHost({
    paseoHome,
    logger: pino({ level: "silent" }),
    isEnabled: () => true,
    ...(engine === "moli"
      ? {
          resolveExecutable: async () => ({
            ok: true as const,
            path: MOLI_BIN,
            source: "config" as const,
          }),
          launch: launchMoli as never,
        }
      : {}),
  });
let host = makeHost();
const exec = (command: unknown) =>
  host.execute({
    type: "browser.automation.execute.request",
    requestId: "r",
    workspaceId: "ws",
    command,
  } as never);
async function refFor(id: string, role: string, name: string): Promise<string> {
  const r = (await exec({ command: "snapshot", args: { browserId: id } })) as {
    result?: { snapshot?: string };
  };
  const text = r.result?.snapshot ?? "";
  const ref = new RegExp(`${role} "${name}"[^\\n]*?\\b(e\\d+)\\b`).exec(text)?.[1];
  if (!ref) throw new Error(`no ref for ${role} "${name}" in ${text.slice(0, 400)}`);
  return `@${ref}`;
}
const evaluate = (id: string, js: string) => host.getTab(id)!.contents.executeJavaScript(js);

try {
  let id = "";
  await check("openTab (launch, createTarget, attach, Page/Runtime enable, viewport)", async () => {
    const t0 = Date.now();
    const tab = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "agent" });
    id = tab.browserId;
    return `${Date.now() - t0} ms; tabs=${JSON.stringify(host.listTabs().map((t) => t.title))}`;
  });
  await check("snapshot (ARIA script, @eN refs)", async () => {
    const r = (await exec({ command: "snapshot", args: { browserId: id } })) as {
      ok: boolean;
      result?: unknown;
      error?: unknown;
    };
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return JSON.stringify((r.result as { snapshot?: string }).snapshot);
  });
  await check("click by ref → navigates (link)", async () => {
    const ref = await refFor(id, "link", "Go to form");
    const r = (await exec({ command: "click", args: { browserId: id, ref } })) as {
      ok: boolean;
      error?: unknown;
    };
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    await sleep(800);
    return `url=${host.getTab(id)!.currentUrl}`;
  });
  await check("fill + click (form)", async () => {
    const email = await refFor(id, "textbox", "Email");
    const button = await refFor(id, "button", "Sign in");
    const f = (await exec({
      command: "fill",
      args: { browserId: id, ref: email, value: "a@b.co" },
    })) as { ok: boolean; error?: unknown };
    if (!f.ok) throw new Error(`fill: ${JSON.stringify(f.error)}`);
    const c = (await exec({ command: "click", args: { browserId: id, ref: button } })) as {
      ok: boolean;
      error?: unknown;
    };
    if (!c.ok) throw new Error(`click: ${JSON.stringify(c.error)}`);
    return `sent=${await evaluate(id, "document.body.dataset.sent")}`;
  });
  await check("select option", async () => {
    const sel = await refFor(id, "combobox", "Plan");
    const r = (await exec({
      command: "select",
      args: { browserId: id, ref: sel, value: "pro" },
    })) as { ok: boolean; error?: unknown };
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return `value=${await evaluate(id, "document.querySelector('select').value")}`;
  });
  await check("back / forward", async () => {
    const r = (await exec({ command: "back", args: { browserId: id } })) as {
      ok: boolean;
      error?: unknown;
    };
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    await sleep(800);
    return `after back url=${host.getTab(id)!.currentUrl}`;
  });
  await check("screenshot command", async () => {
    const r = (await exec({ command: "screenshot", args: { browserId: id } })) as {
      ok: boolean;
      error?: unknown;
      result?: unknown;
    };
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return JSON.stringify(r.result).slice(0, 120);
  });
  await check("scroll command", async () => {
    const r = (await exec({
      command: "scroll",
      args: { browserId: id, deltaX: 0, deltaY: 600 },
    })) as { ok: boolean; error?: unknown };
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    await sleep(300);
    return `scrollY=${await evaluate(id, "scrollY")}`;
  });
  await check("resize to Phone (390x844, mobile=true)", async () => {
    const r = (await exec({
      command: "resize",
      args: { browserId: id, width: 390, height: 844 },
    })) as { ok: boolean; error?: unknown };
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return `innerWidth=${await evaluate(id, "innerWidth")}`;
  });
  await check("viewer setViewport Phone preset", async () => {
    const tab = host.getTab(id)!;
    await tab.setViewport({ width: 390, height: 844, mobile: true } as never);
    return `screen.width=${await evaluate(id, "screen.width")} dpr=${await evaluate(id, "devicePixelRatio")}`;
  });
  await check("viewer setViewport Desktop preset", async () => {
    const tab = host.getTab(id)!;
    await tab.setViewport({ width: 1280, height: 800, mobile: false } as never);
    return `innerWidth=${await evaluate(id, "innerWidth")}`;
  });
  await check("viewer input batch (move/down/up as fractions)", async () => {
    const tab = host.getTab(id)!;
    await exec({ command: "navigate", args: { browserId: id, url: siteUrl } });
    await sleep(500);
    const at = { x: 0.1, y: 0.35 };
    for (let i = 0; i < 3; i++) {
      await Promise.all([
        tab.dispatchInput([
          { kind: "mouse", action: "move", ...at, button: "none", clickCount: 0 },
          { kind: "mouse", action: "down", ...at, button: "left", clickCount: 1 },
        ] as never),
        tab.dispatchInput([
          { kind: "mouse", action: "up", ...at, button: "left", clickCount: 1 },
        ] as never),
      ]);
    }
    const n = await evaluate(id, "document.getElementById('add').dataset.n");
    if (n !== "3") throw new Error(`clicks=${n}`);
    return "3 clicks";
  });
  await check("persistence across browser restart (profile dir)", async () => {
    await evaluate(
      id,
      "document.cookie = 'session=abc; max-age=3600'; localStorage.setItem('token', 'xyz')",
    );
    await host.shutdown();
    host = makeHost();
    const again = await host.openTab({ workspaceId: "ws", url: siteUrl, openedBy: "user" });
    id = again.browserId;
    const cookie = await evaluate(id, "document.cookie");
    const token = await evaluate(id, "localStorage.getItem('token')");
    if (cookie !== "session=abc" || token !== "xyz")
      throw new Error(`cookie=${cookie} token=${token}`);
    return `cookie=${cookie} token=${token}`;
  });
  await check("workspace isolation (second workspace, own browser)", async () => {
    const other = await host.openTab({ workspaceId: "ws-b", url: siteUrl, openedBy: "user" });
    const v = await evaluate(other.browserId, "document.cookie");
    if (v) throw new Error(`ws-b sees ${v}`);
    return "ws-b sees no cookie";
  });
  await check("clearWorkspaceData", async () => {
    await host.clearWorkspaceData("ws");
    await sleep(1500);
    return `token after clear=${await evaluate(id, "localStorage.getItem('token')")}`;
  });
  await check("close_tab", async () => {
    const r = (await exec({ command: "close_tab", args: { browserId: id } })) as {
      ok: boolean;
      error?: unknown;
    };
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return `tabs left=${host.listTabs().length}`;
  });
} finally {
  await host.shutdown().catch(() => {});
  site.close();
  rmSync(paseoHome, { recursive: true, force: true });
}
console.log(JSON.stringify({ engine, results }, null, 1));
process.exit(0);
