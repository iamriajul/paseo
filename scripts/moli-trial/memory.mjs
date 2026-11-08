// Process-tree RSS/PSS of one browser holding 1, 3 and 9 tabs across up to 3 browser contexts.
// Fresh browser per run; each tab cycles through the given page list.
// Usage: node scripts/moli-trial/memory.mjs <engine> <runs> url1 url2 ...
import { Cdp, launch, openPage, sleep, treeMemory } from "./lib.mjs";

const [engine, runsArg, ...urls] = process.argv.slice(2);
const runs = Number(runsArg ?? 3);
const SETTLE_MS = 6000;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
async function sample(pid) {
  const xs = [];
  for (let i = 0; i < 3; i++) {
    xs.push(treeMemory(pid));
    await sleep(700);
  }
  return {
    procs: median(xs.map((x) => x.procs)),
    rssMB: Math.round(median(xs.map((x) => x.rssMB))),
    pssMB: Math.round(median(xs.map((x) => x.pssMB))),
  };
}

async function closeDefaultPages(cdp) {
  for (const t of (await cdp.send("Target.getTargets")).targetInfos) {
    if (t.type === "page")
      await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  }
}

for (let run = 1; run <= runs; run++) {
  for (const tabs of [1, 3, 9]) {
    const b = await launch(engine, { moliArgs: ["--layout", "-r"] });
    const cdp = await Cdp.connect(b.wsUrl);
    try {
      await sleep(1000);
      const idle = await sample(b.pid);
      // Close the default about:blank page so every engine counts only our tabs.
      await closeDefaultPages(cdp);
      const contexts = [];
      for (let i = 0; i < Math.min(3, tabs); i++)
        contexts.push((await cdp.send("Target.createBrowserContext")).browserContextId);
      const t0 = Date.now();
      const failures = [];
      for (let i = 0; i < tabs; i++) {
        const { sessionId: s } = await openPage(cdp, {
          browserContextId: contexts[i % contexts.length],
        });
        await cdp.send("Page.enable", {}, s);
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
          s,
        );
        const url = urls[i % urls.length];
        const loaded = cdp
          .waitFor((e) => e.sessionId === s && e.method === "Page.loadEventFired", 30000)
          .catch(() => failures.push(url));
        await cdp.send("Page.navigate", { url }, s, 30000);
        await loaded;
      }
      const openMs = Date.now() - t0;
      await sleep(SETTLE_MS);
      const loadedMem = await sample(b.pid);
      console.log(
        JSON.stringify({
          engine,
          run,
          tabs,
          contexts: contexts.length,
          idle,
          loaded: loadedMem,
          openMs,
          failures,
        }),
      );
    } catch (e) {
      console.log(JSON.stringify({ engine, run, tabs, error: String(e.message).slice(0, 200) }));
    } finally {
      cdp.close();
      await b.kill();
      await sleep(1000);
    }
  }
}
