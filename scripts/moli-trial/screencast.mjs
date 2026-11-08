// Live-view cost: screencast fps/CPU on an animating and a static page, click→changed-pixel
// latency, and the cost of polling Page.captureScreenshot instead.
// Usage: node scripts/moli-trial/screencast.mjs <engine> [moliIntervalMs]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Cdp, launch, navigateAndWait, openPage, serveFixtures, sleep, treeTicks } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2] ?? "moli";
const interval = process.argv[3];
const moliArgs = ["--layout", "-r", ...(interval ? ["--screencast-interval-ms", interval] : [])];
const TICK = 100; // USER_HZ
const WINDOW_MS = 5000;

const fx = await serveFixtures(join(here, "fixtures"));
const b = await launch(engine, { moliArgs });
const cdp = await Cdp.connect(b.wsUrl);
const out = { engine: interval ? `${engine}@${interval}ms` : engine };

async function cpuDuring(fn) {
  const t0 = treeTicks(b.pid);
  const w0 = Date.now();
  const r = await fn();
  const pct = ((treeTicks(b.pid) - t0) / TICK / ((Date.now() - w0) / 1000)) * 100;
  return { ...r, cpuPct: Math.round(pct) };
}

async function screencast(sessionId, ms, onFrame) {
  let frames = 0;
  let bytes = 0;
  const off = cdp.on((e) => {
    if (e.method !== "Page.screencastFrame" || e.sessionId !== sessionId) return;
    frames++;
    bytes += e.params.data.length * 0.75;
    onFrame?.(e);
    cdp
      .send("Page.screencastFrameAck", { sessionId: e.params.sessionId }, sessionId)
      .catch(() => {});
  });
  await cdp.send(
    "Page.startScreencast",
    { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
    sessionId,
  );
  await sleep(ms);
  await cdp.send("Page.stopScreencast", {}, sessionId);
  off();
  return {
    fps: +(frames / (ms / 1000)).toFixed(1),
    kbPerFrame: frames ? Math.round(bytes / frames / 1024) : 0,
    mbitPerS: +((bytes * 8) / (ms / 1000) / 1e6).toFixed(2),
  };
}

async function centerColor(b64) {
  const { data, info } = await sharp(Buffer.from(b64, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

try {
  const { sessionId: s } = await openPage(cdp);
  await cdp.send("Page.enable", {}, s);
  await cdp.send("Runtime.enable", {}, s);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    s,
  );

  await navigateAndWait(cdp, s, `${fx.base}/anim.html`);
  await sleep(500);
  out.animIdleNoViewer = await cpuDuring(async () => (await sleep(WINDOW_MS), {}));
  out.animScreencast = await cpuDuring(() => screencast(s, WINDOW_MS));

  await navigateAndWait(cdp, s, `${fx.base}/layout.html`);
  await sleep(500);
  out.staticIdleNoViewer = await cpuDuring(async () => (await sleep(WINDOW_MS), {}));
  out.staticScreencast = await cpuDuring(() => screencast(s, WINDOW_MS));

  // Polling: back-to-back JPEG screenshots on the animating page.
  await navigateAndWait(cdp, s, `${fx.base}/anim.html`);
  await sleep(300);
  out.pollScreenshots = await cpuDuring(async () => {
    const lat = [];
    const end = Date.now() + WINDOW_MS;
    while (Date.now() < end) {
      const t = performance.now();
      await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, s);
      lat.push(performance.now() - t);
    }
    lat.sort((a, c) => a - c);
    return {
      shotsPerS: +(lat.length / (WINDOW_MS / 1000)).toFixed(1),
      p50ms: Math.round(lat[lat.length >> 1]),
      p95ms: Math.round(lat[Math.floor(lat.length * 0.95)]),
    };
  });

  // Click → changed pixel, through the screencast (what a viewer sees).
  await cdp.send(
    "Page.navigate",
    {
      url: `data:text/html,<body style="margin:0"><div id=d style="width:100vw;height:100vh;background:rgb(255,0,0)" onmousedown="window.n=(window.n||0)+1;this.style.background=window.n%2?'rgb(0,0,255)':'rgb(255,0,0)'"></div>`,
    },
    s,
  );
  await sleep(800);
  const lat = [];
  let want = null;
  let t0 = 0;
  let resolveHit;
  const frameHandler = async (e) => {
    if (!want) return;
    const c = await centerColor(e.params.data);
    if (want && Math.abs(c[0] - want[0]) < 40 && Math.abs(c[2] - want[2]) < 40) {
      lat.push(performance.now() - t0);
      want = null;
      resolveHit?.();
    }
  };
  const off = cdp.on((e) => {
    if (e.method === "Page.screencastFrame" && e.sessionId === s) {
      frameHandler(e);
      cdp.send("Page.screencastFrameAck", { sessionId: e.params.sessionId }, s).catch(() => {});
    }
  });
  await cdp.send(
    "Page.startScreencast",
    { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
    s,
  );
  await sleep(1200);
  let misses = 0;
  for (let i = 0; i < 20; i++) {
    want = i % 2 === 0 ? [0, 0, 255] : [255, 0, 0];
    const hit = new Promise((r) => (resolveHit = r));
    t0 = performance.now();
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 640, y: 400, button: "left", clickCount: 1 },
      s,
    );
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: 640, y: 400, button: "left", clickCount: 1 },
      s,
    );
    const ok = await Promise.race([hit.then(() => true), sleep(4000).then(() => false)]);
    if (!ok) {
      misses++;
      want = null;
    }
    await sleep(150 + Math.random() * 100);
  }
  await cdp.send("Page.stopScreencast", {}, s);
  off();
  lat.sort((a, c) => a - c);
  out.clickToPixel = {
    n: lat.length,
    misses,
    p50ms: Math.round(lat[lat.length >> 1] ?? NaN),
    p95ms: Math.round(lat[Math.floor(lat.length * 0.95)] ?? NaN),
  };
} finally {
  cdp.close();
  await b.kill();
  fx.close();
}
console.log(JSON.stringify(out));
