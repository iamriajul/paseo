// End-to-end server browser stream bench: a real daemon, the real web app in Playwright, a test
// page that paints Date.now() as a barcode every frame. The app's probe hook reads the barcode
// from each frame it paints, so latency is page paint → frame on the viewer's screen.
//
// node scripts/server-browser-video-bench/app-bench.mjs '<json options>'
//   daemonPort   the isolated dev daemon (never 6767)
//   daemonPid    for CPU accounting (its Chrome is a child)
//   appUrl       where the web app is served
//   offerUrl     optional: pair through this relay offer instead of connecting directly
//   serverId     the daemon's server id
//   mode         "jpeg" | "video"   (jpeg hides VideoDecoder from the app)
//   workload     "anim" | "long"
//   width,height viewer viewport (CSS px)
//   secs         measurement window
//   label        free text, recorded with the result
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(import.meta.dirname, "../..");
const opts = JSON.parse(process.argv[2]);
const { chromium } = await import(
  pathToFileURL(path.join(REPO, "node_modules/playwright/index.mjs")).href
);
const { WebSocket } = await import(
  pathToFileURL(path.join(REPO, "node_modules/ws/wrapper.mjs")).href
);
const { DaemonClient } = await import(
  pathToFileURL(path.join(REPO, "packages/client/dist/daemon-client.js")).href
);
const { buildHostWorkspaceRoute } = await importRoutes();

const BAR = `<canvas id=bc width=480 height=12 style="position:fixed;left:0;top:0;z-index:99"></canvas>
<script>const bc=document.getElementById('bc').getContext('2d');
function tick(){const t=Date.now()%2**40;for(let i=0;i<40;i++){bc.fillStyle=(Math.floor(t/2**i)%2)?'#fff':'#000';bc.fillRect(i*12,0,12,12);}requestAnimationFrame(tick)}tick();</script>`;
const PAGES = {
  anim: `<!doctype html><title>anim</title><body style="margin:0;background:#fff;font:16px sans-serif">${BAR}
<style>.b{position:absolute;width:120px;height:120px;border-radius:16px;animation:m 2s linear infinite}
@keyframes m{0%{transform:translate(0,40px) rotate(0)}50%{transform:translate(900px,400px) rotate(180deg)}100%{transform:translate(0,40px) rotate(360deg)}}</style>
${Array.from({ length: 12 }, (_, i) => `<div class=b style="left:${(i % 4) * 60}px;top:${Math.floor(i / 4) * 150 + 30}px;background:hsl(${i * 30} 80% 50%);animation-delay:-${i * 0.17}s"></div>`).join("")}
<p style="position:absolute;top:640px;left:20px;width:1100px">${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20)}</p></body>`,
  long: `<!doctype html><title>long</title><body style="margin:0;font:16px/1.5 sans-serif">${BAR}<div style="padding:20px 40px">${Array.from({ length: 400 }, (_, i) => `<h3 style="color:hsl(${(i * 37) % 360} 60% 40%)">Section ${i}</h3><p>${"The quick brown fox jumps over the lazy dog. ".repeat(8)}</p><div style="height:40px;background:linear-gradient(90deg,hsl(${(i * 37) % 360} 70% 60%),#fff)"></div>`).join("")}</div>
<script>(function s(){scrollBy(0,6);if(scrollY+innerHeight>=document.body.scrollHeight-2)scrollTo(0,0);requestAnimationFrame(s)})()</script></body>`,
};

const site = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(PAGES[(req.url ?? "/").slice(1)] ?? PAGES.anim);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}`;

const client = new DaemonClient({
  url: `ws://127.0.0.1:${opts.daemonPort}/ws`,
  clientId: `video-bench-${randomUUID()}`,
  clientType: "cli",
  appVersion: JSON.parse(fs.readFileSync(path.join(REPO, "packages/app/package.json"), "utf8"))
    .version,
  webSocketFactory: (url, o) => new WebSocket(url, { headers: o?.headers }),
});
await client.connect();
const workspaceDir = "/tmp/sbv/bench-workspace";
fs.mkdirSync(workspaceDir, { recursive: true });
const workspaceIdFile = "/tmp/sbv/bench-workspace.id";
let workspaceId = fs.existsSync(workspaceIdFile) ? fs.readFileSync(workspaceIdFile, "utf8") : "";
if (!workspaceId) {
  const created = await client.createWorkspace({
    source: { kind: "directory", path: workspaceDir },
  });
  workspaceId = created.workspace?.id ?? "";
  if (!workspaceId) throw new Error(`no workspace: ${created.error}`);
  fs.writeFileSync(workspaceIdFile, workspaceId);
}
// The app shows agents' tabs in the workspace by itself; open the tab as a mock agent does.
const { Client: McpClient } = await import(
  pathToFileURL(path.join(REPO, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"))
    .href
);
const { StreamableHTTPClientTransport } = await import(
  pathToFileURL(
    path.join(REPO, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"),
  ).href
);
const agent = await client.createAgent({
  provider: "mock",
  model: "e2e-fast-stream",
  cwd: workspaceDir,
  workspaceId,
  title: "Video bench",
  modeId: "load-test",
});
const mcp = new McpClient({ name: "video-bench", version: "1" });
await mcp.connect(
  new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${opts.daemonPort}/mcp/agents?callerAgentId=${agent.id}`),
  ),
);
// A run that failed leaves its tab behind; two mounted surfaces confuse the probe.
const listed = await mcp.callTool({ name: "browser_list_tabs", arguments: {} });
for (const stale of listed.structuredContent?.result?.tabs ?? []) {
  await mcp.callTool({ name: "browser_close_tab", arguments: { browserId: stale.browserId } });
}
const opened = await mcp.callTool({
  name: "browser_new_tab",
  arguments: { url: `${siteUrl}/${opts.workload}`, target: "server" },
});
const browserId = String(opened.structuredContent?.result?.browserId ?? "");
if (!browserId) throw new Error(`browser_new_tab: ${JSON.stringify(opened).slice(0, 400)}`);

const browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
const context = await browser.newContext({
  // Phone-width deep links land on open-project: open the workspace wide, then resize.
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: opts.width < 600 ? 2 : 1,
});
const page = await context.newPage();
await page.addInitScript(
  ({ mode, pageWidth }) => {
    if (mode === "jpeg") {
      delete globalThis.VideoDecoder;
      delete globalThis.EncodedVideoChunk;
    }
    const stats = { lat: [], perSec: {}, frames: 0, kinds: {} };
    globalThis.__sbv = stats;
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 12;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    globalThis.__paseoServerBrowserProbe = (element) => {
      const now = Date.now();
      const frameWidth =
        element instanceof HTMLCanvasElement ? element.width : element.naturalWidth;
      const scale = frameWidth / pageWidth;
      ctx.drawImage(element, 0, 0, 480 * scale, 12 * scale, 0, 0, 480, 12);
      const px = ctx.getImageData(0, 0, 480, 12).data;
      let t = 0;
      for (let i = 39; i >= 0; i--) {
        const o = (6 * 480 + i * 12 + 6) * 4;
        t = t * 2 + ((px[o] + px[o + 1] + px[o + 2]) / 3 > 128 ? 1 : 0);
      }
      const latency = (now % 2 ** 40) - t;
      if (latency >= 0 && latency < 20000) stats.lat.push(latency);
      const second = Math.floor(now / 1000);
      stats.perSec[second] = (stats.perSec[second] ?? 0) + 1;
      stats.frames += 1;
      const kind = element.tagName;
      stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1;
    };
  },
  { mode: opts.mode, pageWidth: 1280 },
);
let wsBytes = 0;
const wire = { video: 0, key: 0, jpeg: 0 };
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
cdp.on("Network.webSocketFrameReceived", (event) => {
  const { opcode, payloadData } = event.response;
  wsBytes += opcode === 2 ? Math.floor((payloadData.length * 3) / 4) : payloadData.length;
  if (opcode === 2) {
    const head = Buffer.from(payloadData.slice(0, 24), "base64");
    if (head[0] === 0x42) {
      wire.video += 1;
      if (head[13] & 1) wire.key += 1;
    } else if (head[0] === 0x40) wire.jpeg += 1;
  }
});

if (opts.offerUrl) {
  // A fresh origin with no host: pair through the relay the way a user pastes a link.
  await page.goto(opts.appUrl, { waitUntil: "commit" });
  await page.getByText("Paste pairing link").click({ timeout: 90_000 });
  await page.getByTestId("pair-link-input").fill(opts.offerUrl);
  await page.getByTestId("pair-link-submit").click();
  await page.getByRole("button", { name: "Connect", exact: true }).click({ timeout: 30_000 });
  await page.waitForTimeout(3000);
}
// Straight to the workspace route, the app redirects before it knows the host; load it first.
await page.goto(opts.appUrl, { waitUntil: "commit" });
await page
  .getByText("bench-workspace")
  .first()
  .waitFor({ timeout: 90_000 })
  .catch(async (error) => {
    await page.screenshot({ path: "/tmp/sbv/fail.png" });
    console.error("app never listed the workspace; url", page.url());
    throw error;
  });
await page.goto(`${opts.appUrl}${buildHostWorkspaceRoute(opts.serverId, workspaceId)}`, {
  waitUntil: "commit",
});
const tab = page.getByTestId(`workspace-tab-server_browser_${browserId}`);
try {
  await tab.first().click({ timeout: 90_000 });
} catch (error) {
  await page.screenshot({ path: "/tmp/sbv/fail.png" });
  console.error("tab not found; url", page.url());
  throw error;
}
await page.getByTestId("server-browser-surface").waitFor({ timeout: 60_000 });
await page.setViewportSize({ width: opts.width, height: opts.height });
await page.waitForFunction(() => globalThis.__sbv.frames > 20, null, { timeout: 60_000 });
await page.waitForTimeout(2000);
if (opts.screenshot) await page.screenshot({ path: opts.screenshot });

const ticks = treeTicks(Number(opts.daemonPid));
const viewerTicks = treeTicks(process.pid, true);
await page.evaluate(() => {
  const s = globalThis.__sbv;
  s.lat = [];
  s.perSec = {};
  s.frames = 0;
  s.kinds = {};
});
const t0 = Date.now();
const w0 = { ...wire };
const b0 = wsBytes;
const d0 = ticks();
const v0 = viewerTicks();
await page.waitForTimeout(opts.secs * 1000);
const elapsed = (Date.now() - t0) / 1000;
const d1 = ticks();
const v1 = viewerTicks();
const stats = await page.evaluate(() => globalThis.__sbv);
const seconds = Object.keys(stats.perSec).map(Number).sort();
const full = seconds.slice(1, -1).map((key) => stats.perSec[key]);
const lat = stats.lat.sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
const result = {
  at: new Date().toISOString(),
  label: opts.label,
  mode: opts.mode,
  workload: opts.workload,
  viewer: `${opts.width}x${opts.height}`,
  path: opts.offerUrl ? "relay" : "direct",
  shown: stats.kinds,
  wire: { video: wire.video - w0.video, key: wire.key - w0.key, jpeg: wire.jpeg - w0.jpeg },
  fpsWorst: full.length ? Math.min(...full) : 0,
  fpsMed: full.length ? full.sort((a, b) => a - b)[Math.floor(full.length / 2)] : 0,
  latP50: q(0.5),
  latP99: q(0.99),
  kbps: Math.round(((wsBytes - b0) * 8) / elapsed / 1000),
  daemonCpu: Math.round((d1.self - d0.self) / elapsed),
  chromeCpu: Math.round((d1.children - d0.children) / elapsed),
  viewerCpu: Math.round((v1.children - v0.children) / elapsed),
  load: fs.readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" "),
};
console.log(JSON.stringify(result));
fs.appendFileSync("/tmp/sbv/app-results.jsonl", `${JSON.stringify(result)}\n`);
await client.serverBrowserCloseTab(browserId).catch(() => {});
await mcp.close().catch(() => {});
await client.archiveAgent?.(agent.id).catch(() => {});
await browser.close();
await client.close();
site.close();
process.exit(0);

/** CPU ticks (1/100 s) of a process (`self`) and of all its descendants (`children`). */
function treeTicks(root, excludeSelf = false) {
  return () => {
    const parent = {};
    const cpu = {};
    for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        parent[pid] = fields[1];
        cpu[pid] = Number(fields[11]) + Number(fields[12]);
      } catch {}
    }
    const tree = new Set([String(root)]);
    for (let grown = true; grown; ) {
      grown = false;
      for (const [pid, ppid] of Object.entries(parent)) {
        if (tree.has(ppid) && !tree.has(pid)) {
          tree.add(pid);
          grown = true;
        }
      }
    }
    tree.delete(String(root));
    let children = 0;
    for (const pid of tree) children += cpu[pid] ?? 0;
    return { self: excludeSelf ? 0 : (cpu[String(root)] ?? 0), children };
  };
}

async function importRoutes() {
  // host-routes.ts is app source; the bench only needs its workspace route shape.
  return {
    buildHostWorkspaceRoute: (serverId, id) =>
      `/h/${encodeURIComponent(serverId)}/workspace/${encodeWorkspaceId(id)}`,
  };
}

function encodeWorkspaceId(id) {
  if (/^[A-Za-z0-9._~-]+$/.test(id)) return id;
  return `b64_${Buffer.from(id, "utf8").toString("base64url")}`;
}
