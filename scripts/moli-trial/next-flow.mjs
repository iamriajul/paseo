// Real-app flows on the Next.js fixture (port 3791): client-side routing, a cookie login that
// survives a browser restart on the same profile, and the canvas page. Also probes Paseo's own
// web app (Expo web on 8191) for how long the engine takes to get it interactive.
// Usage: node scripts/moli-trial/next-flow.mjs <engine> [paseoUrl]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, evaluate, launch, openPage, sleep, treeTicks } from "./lib.mjs";

const engine = process.argv[2] ?? "moli";
const paseoUrl = process.argv[3];
const NEXT = "http://127.0.0.1:3791";
const profileDir = mkdtempSync(join(tmpdir(), `moli-flow-${engine}-`));
const out = { engine };

async function withBrowser(fn) {
  const b = await launch(engine, { profileDir, moliArgs: ["--layout", "-r"] });
  const cdp = await Cdp.connect(b.wsUrl);
  try {
    const { sessionId: s } = await openPage(cdp);
    await cdp.send("Page.enable", {}, s);
    await cdp.send("Runtime.enable", {}, s);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      s,
    );
    return await fn(cdp, s, b);
  } finally {
    // Graceful close first so the profile flushes, like the daemon's shutdown.
    await cdp.send("Browser.close").catch(() => {});
    await sleep(1500);
    cdp.close();
    await b.kill();
  }
}
async function go(cdp, s, url) {
  const p = cdp
    .waitFor((e) => e.sessionId === s && e.method === "Page.loadEventFired", 20000)
    .catch(() => null);
  await cdp.send("Page.navigate", { url }, s);
  await p;
  await sleep(500);
}
async function click(cdp, s, selector) {
  const box = await evaluate(
    cdp,
    s,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
  );
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await cdp.send(
      "Input.dispatchMouseEvent",
      {
        type,
        x: box[0],
        y: box[1],
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      },
      s,
    );
}
async function typeInto(cdp, s, selector, text) {
  await click(cdp, s, selector);
  await cdp.send("Input.insertText", { text }, s);
}

await withBrowser(async (cdp, s) => {
  // Client-side routing: a Link click must not reload the document.
  await go(cdp, s, `${NEXT}/about`);
  await evaluate(cdp, s, "window.__marker = 'same-document'; 1");
  const loadsBefore = cdp.events.filter(
    (e) => e.sessionId === s && e.method === "Page.loadEventFired",
  ).length;
  await click(cdp, s, "a[href='/canvas']");
  await sleep(1500);
  const loadsAfter = cdp.events.filter(
    (e) => e.sessionId === s && e.method === "Page.loadEventFired",
  ).length;
  out.clientRouting = {
    url: await evaluate(cdp, s, "location.pathname"),
    sameDocument: (await evaluate(cdp, s, "window.__marker")) === "same-document",
    fullLoads: loadsAfter - loadsBefore,
    withinDocumentEvent: cdp.events.some(
      (e) =>
        e.sessionId === s &&
        e.method === "Page.navigatedWithinDocument" &&
        e.params.url?.endsWith("/canvas"),
    ),
    heading: await evaluate(cdp, s, "document.querySelector('h1')?.textContent"),
  };
  // Canvas: is the animation running and does it paint?
  const f0 = await evaluate(cdp, s, "document.getElementById('frames')?.textContent");
  await sleep(1000);
  out.canvas = {
    framesText: [f0, await evaluate(cdp, s, "document.getElementById('frames')?.textContent")],
    hslSpaceSyntax: await evaluate(
      cdp,
      s,
      "(() => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = '#111'; c.fillStyle = 'hsl(270 80% 55%)'; return c.fillStyle; })()",
    ),
    centerPixel: await evaluate(
      cdp,
      s,
      "(() => { const c = document.querySelector('canvas'); return Array.from(c.getContext('2d').getImageData(200, 150, 1, 1).data); })()",
    ),
  };
  // Login with the real form: click, type, submit.
  await go(cdp, s, `${NEXT}/dashboard`);
  out.login = { redirectedTo: await evaluate(cdp, s, "location.pathname") };
  await typeInto(cdp, s, "input[name=user]", "moli");
  await typeInto(cdp, s, "input[name=password]", "hunter2");
  await click(cdp, s, "button[type=submit]");
  await sleep(2500);
  out.login.after = await evaluate(
    cdp,
    s,
    "[location.pathname, document.getElementById('welcome')?.textContent]",
  );
  out.login.documentCookieHidden = (await evaluate(cdp, s, "document.cookie")) === "";
});
await withBrowser(async (cdp, s) => {
  await go(cdp, s, `${NEXT}/dashboard`);
  out.login.afterRestart = await evaluate(
    cdp,
    s,
    "[location.pathname, document.getElementById('welcome')?.textContent]",
  );
});

if (paseoUrl) {
  await withBrowser(async (cdp, s, b) => {
    const t0 = Date.now();
    const ticks0 = treeTicks(b.pid);
    cdp.send("Page.navigate", { url: paseoUrl }, s, 200000).catch(() => {});
    const samples = [];
    while (Date.now() - t0 < 180000) {
      await sleep(5000);
      const v = await evaluate(
        cdp,
        s,
        "[document.readyState, document.querySelectorAll('*').length, document.body?.innerText?.slice(0, 60)]",
        4000,
      ).catch((e) => e.message.slice(0, 60));
      samples.push({ t: Math.round((Date.now() - t0) / 1000), v });
      if (Array.isArray(v) && v[1] > 100) break;
    }
    out.paseo = { samples, cpuSeconds: (treeTicks(b.pid) - ticks0) / 100 };
  });
}
rmSync(profileDir, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
