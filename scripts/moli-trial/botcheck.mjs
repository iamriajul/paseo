// Informational only: loads public headless/bot-detection test pages in Moli, the headless shell
// and headed Chrome (under a private Xvfb), records what each page reports, and screenshots it.
// No logins, no accounts. Usage: node scripts/moli-trial/botcheck.mjs <outDir>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, evaluate, killGroup, launch, openPage, sleep } from "./lib.mjs";

const outDir = process.argv[2];
mkdirSync(outDir, { recursive: true });
const PAGES = [
  { name: "sannysoft", url: "https://bot.sannysoft.com/", wait: 6000 },
  { name: "areyouheadless", url: "https://arh.antoinevastel.com/bots/areyouheadless", wait: 4000 },
  { name: "creepjs", url: "https://abrahamjuliot.github.io/creepjs/", wait: 15000 },
];
const FINGERPRINT = `({
  ua: navigator.userAgent, webdriver: navigator.webdriver, platform: navigator.platform,
  languages: navigator.languages, plugins: navigator.plugins?.length, hc: navigator.hardwareConcurrency,
  chrome: typeof window.chrome, uaData: navigator.userAgentData?.brands?.map(b => b.brand + ' ' + b.version),
  webgl: (() => { try { const g = document.createElement('canvas').getContext('webgl'); const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : (g ? 'no debug ext' : 'no webgl'); } catch (e) { return 'err ' + e.message } })(),
  screen: [screen.width, screen.height, screen.colorDepth], outer: [outerWidth, outerHeight],
  permissions: typeof navigator.permissions?.query, notification: typeof Notification !== 'undefined' ? Notification.permission : 'none',
})`;

async function checkPage(cdp, engine, page) {
  const { targetId, sessionId: s } = await openPage(cdp);
  await cdp.send("Page.enable", {}, s);
  if (engine !== "chrome-headed")
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      s,
    );
  const r = { engine };
  try {
    await cdp.send("Page.navigate", { url: page.url }, s, 30000);
    await cdp
      .waitFor((e) => e.sessionId === s && e.method === "Page.loadEventFired", 30000)
      .catch(() => {});
    await sleep(page.wait);
    r.fingerprint = await evaluate(cdp, s, FINGERPRINT).catch((e) => e.message);
    r.text = await evaluate(cdp, s, "document.body.innerText.slice(0, 6000)").catch(
      (e) => e.message,
    );
    const { data } = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      s,
      30000,
    );
    writeFileSync(join(outDir, `${page.name}-${engine}.png`), Buffer.from(data, "base64"));
  } catch (e) {
    r.error = String(e.message).slice(0, 200);
  }
  (results[page.name] ??= {})[engine] = r;
  await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
}

const display = ":97";
const xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
  detached: true,
  stdio: "ignore",
});
await sleep(800);
const results = {};
try {
  for (const engine of ["moli", "shell", "chrome-headed"]) {
    const b = await launch(engine, {
      moliArgs: ["--layout", "-r"],
      env: engine === "chrome-headed" ? { DISPLAY: display } : undefined,
    });
    const cdp = await Cdp.connect(b.wsUrl);
    try {
      for (const page of PAGES) await checkPage(cdp, engine, page);
    } finally {
      cdp.close();
      await b.kill();
    }
  }
} finally {
  killGroup(xvfb.pid);
}
writeFileSync(join(outDir, "botcheck.json"), JSON.stringify(results, null, 1));
console.log("done");
