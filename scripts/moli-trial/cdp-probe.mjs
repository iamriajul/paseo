// Exercises every CDP method/event Paseo's server browser uses (plus the ones a shared-Chromium,
// per-workspace-context design would need) against one engine, and prints a JSON result list.
// Usage: node scripts/moli-trial/cdp-probe.mjs <moli|shell|chrome> [--moli-args "..."]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Cdp,
  evaluate,
  launch,
  navigateAndWait,
  openPage,
  pngSize,
  serveFixtures,
  sleep,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const engine = process.argv[2] ?? "moli";
const argIndex = process.argv.indexOf("--moli-args");
const moliArgs = (argIndex > 0 ? process.argv[argIndex + 1] : "--layout -r")
  .split(" ")
  .filter(Boolean);

// Pull the engine's real ARIA snapshot script out of the vendored TS source.
const ariaSrc = readFileSync(
  join(here, "../../packages/server/src/server/server-browser/engine/aria-snapshot-script.ts"),
  "utf8",
);
const ARIA_MARKER = /ARIA_SNAPSHOT_SCRIPT_MARKER = "([^"]+)"/.exec(ariaSrc)[1];
const ARIA_SCRIPT = /String\.raw`([\s\S]*)`;\s*$/m
  .exec(ariaSrc)[1]
  .replace("${JSON.stringify(ARIA_SNAPSHOT_SCRIPT_MARKER)}", JSON.stringify(ARIA_MARKER));

const results = [];
function frameStatus(frames) {
  if (frames >= 30) return "works";
  return frames > 0 ? "partial" : "missing";
}
async function check(area, name, fn) {
  const t0 = Date.now();
  try {
    const r = (await fn()) ?? {};
    results.push({
      area,
      name,
      status: r.status ?? "works",
      note: r.note ?? "",
      ms: Date.now() - t0,
    });
  } catch (e) {
    results.push({
      area,
      name,
      status: "missing",
      note: String(e.message).slice(0, 240),
      ms: Date.now() - t0,
    });
  }
}

const fx = await serveFixtures(join(here, "fixtures"));
const fx2 = await serveFixtures(join(here, "fixtures")); // second origin for cookie/isolation tests
const b = await launch(engine, { moliArgs });
const cdp = await Cdp.connect(b.wsUrl);
let s; // sessionId
let targetId;
let ctxA;
let ctxB;
try {
  await check("Browser", "Browser.getVersion", async () => {
    const v = await cdp.send("Browser.getVersion");
    return { note: `${v.product} / ${v.userAgent?.slice(0, 60)}` };
  });
  await check("Target", "Target.setDiscoverTargets", () =>
    cdp.send("Target.setDiscoverTargets", { discover: true }),
  );
  await check("Browser", "Browser.setDownloadBehavior deny", () =>
    cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }),
  );
  await check("Target", "Target.getTargets", async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return {
      note: `${targetInfos.length} targets, types=${[...new Set(targetInfos.map((t) => t.type))]}`,
    };
  });
  await check("Target", "Target.createBrowserContext (x2)", async () => {
    ctxA = (await cdp.send("Target.createBrowserContext", { disposeOnDetach: false }))
      .browserContextId;
    ctxB = (await cdp.send("Target.createBrowserContext", { disposeOnDetach: false }))
      .browserContextId;
    return { note: `${ctxA} / ${ctxB}` };
  });
  await check("Target", "Target.createTarget + attachToTarget(flatten)", async () => {
    ({ targetId, sessionId: s } = await openPage(cdp, { browserContextId: ctxA }));
    return { note: `target ${targetId}` };
  });
  await check("Page", "Page.enable", () => cdp.send("Page.enable", {}, s));
  await check("Runtime", "Runtime.enable", () => cdp.send("Runtime.enable", {}, s));
  await check("Page", "Page.setLifecycleEventsEnabled", () =>
    cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, s),
  );
  await check("Emulation", "Emulation.setDeviceMetricsOverride 1280x800", async () => {
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      s,
    );
  });
  await check("Emulation", "Emulation.setTouchEmulationEnabled", () =>
    cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, s),
  );

  const evStart = cdp.events.length;
  await check("Page", "Page.navigate + Page.loadEventFired", async () => {
    const ok = await navigateAndWait(cdp, s, `${fx.base}/probe.html`);
    if (!ok) return { status: "partial", note: "navigate returned but no loadEventFired" };
  });
  await sleep(300);
  const seen = new Set(
    cdp.events
      .slice(evStart)
      .filter((e) => e.sessionId === s || !e.sessionId)
      .map((e) => e.method),
  );
  for (const ev of [
    "Page.frameNavigated",
    "Page.frameStartedLoading",
    "Page.frameStoppedLoading",
    "Page.lifecycleEvent",
    "Page.domContentEventFired",
  ]) {
    await check("Page events", ev, async () => {
      if (!seen.has(ev)) throw new Error("not emitted during navigation");
    });
  }
  await check("Target events", "Target.targetInfoChanged (url/title)", async () => {
    const hit = cdp.events.find(
      (e) =>
        e.method === "Target.targetInfoChanged" && e.params.targetInfo?.url?.includes("probe.html"),
    );
    if (!hit) throw new Error("no targetInfoChanged carrying the new URL");
    return { note: `title="${hit.params.targetInfo.title}"` };
  });

  await check("Viewport", "innerWidth/innerHeight after override", async () => {
    const v = await evaluate(cdp, s, "[innerWidth, innerHeight, devicePixelRatio]");
    if (v[0] !== 1280 || v[1] !== 800) return { status: "partial", note: `got ${v}` };
    return { note: `${v}` };
  });
  await check(
    "Emulation",
    "Phone viewport 390x844 dpr2 mobile=true (what Paseo sends)",
    async () => {
      // Without a viewport meta, Chromium lays a mobile page out at 980 px; screen.width shows the override.
      const probe = "[screen.width, screen.height, devicePixelRatio, innerWidth]";
      try {
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
          s,
        );
      } catch (e) {
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: 390, height: 844, deviceScaleFactor: 2, mobile: false },
          s,
        );
        const v = await evaluate(cdp, s, probe);
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
          s,
        );
        return {
          status: "partial",
          note: `mobile=true rejected (${e.message.slice(0, 80)}); mobile=false gives ${v}`,
        };
      }
      const v = await evaluate(cdp, s, probe);
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
        s,
      );
      return {
        status: v[0] === 390 && v[2] === 2 ? "works" : "partial",
        note: `screen/dpr/innerWidth ${v}`,
      };
    },
  );

  await check("Runtime", "Runtime.evaluate returnByValue/awaitPromise", async () => {
    const v = await evaluate(
      cdp,
      s,
      "new Promise(r => setTimeout(() => r({a: document.title}), 50))",
    );
    if (v?.a !== "Probe") throw new Error(`got ${JSON.stringify(v)}`);
  });
  await check("Runtime", "ARIA snapshot script (engine's real one)", async () => {
    const v = await evaluate(cdp, s, ARIA_SCRIPT);
    const text = JSON.stringify(v);
    const hasBtn = text.includes("Click me");
    const hasBox = /textbox/.test(text);
    return {
      status: hasBtn && hasBox ? "works" : "partial",
      note: `${text.length} chars; button=${hasBtn} textbox=${hasBox}; ${text.slice(0, 120)}`,
    };
  });
  await check("Runtime", "Runtime.consoleAPICalled", async () => {
    const p = cdp.waitFor(
      (e) => e.method === "Runtime.consoleAPICalled" && e.sessionId === s,
      3000,
    );
    await evaluate(cdp, s, "console.log('hello-probe')");
    await p;
  });
  await check("Runtime", "Runtime.exceptionThrown", async () => {
    const p = cdp.waitFor((e) => e.method === "Runtime.exceptionThrown" && e.sessionId === s, 3000);
    await evaluate(cdp, s, "setTimeout(() => { throw new Error('boom-probe') }, 0)");
    await p;
  });

  let objectId;
  await check("DOM", "Runtime.evaluate → objectId (element handle)", async () => {
    const r = await cdp.send(
      "Runtime.evaluate",
      { expression: "document.getElementById('file')" },
      s,
    );
    objectId = r.result?.objectId;
    if (!objectId) throw new Error(`no objectId: ${JSON.stringify(r.result)}`);
  });
  await check("DOM", "DOM.describeNode → backendNodeId", async () => {
    const r = await cdp.send("DOM.describeNode", { objectId }, s);
    if (!(r.node?.backendNodeId > 0)) throw new Error(JSON.stringify(r).slice(0, 200));
    return { note: `backendNodeId=${r.node.backendNodeId}` };
  });
  await check("DOM", "DOM.setFileInputFiles (upload)", async () => {
    const path = join(here, "fixtures/probe.html");
    await cdp.send("DOM.setFileInputFiles", { files: [path], objectId }, s);
    const name = await evaluate(cdp, s, "document.getElementById('file').files[0]?.name");
    if (name !== "probe.html") return { status: "partial", note: `files[0].name=${name}` };
  });
  await check("DOM", "DOM.getDocument/querySelector/getBoxModel", async () => {
    const { root } = await cdp.send("DOM.getDocument", {}, s);
    const { nodeId } = await cdp.send(
      "DOM.querySelector",
      { nodeId: root.nodeId, selector: "#btn" },
      s,
    );
    const { model } = await cdp.send("DOM.getBoxModel", { nodeId }, s);
    const [x, y] = model.content;
    // Chromium reports content box 28,23 for this button (padding + border inside 20,20).
    return {
      status: Math.round(x) === 28 && Math.round(y) === 23 ? "works" : "partial",
      note: `content=${model.content.map(Math.round)}`,
    };
  });
  await check("Page", "Page.getLayoutMetrics", async () => {
    const m = await cdp.send("Page.getLayoutMetrics", {}, s);
    const v = m.cssLayoutViewport ?? m.layoutViewport;
    return {
      note: `layoutViewport ${v?.clientWidth}x${v?.clientHeight}, content ${m.cssContentSize?.height ?? m.contentSize?.height}`,
    };
  });
  await check("Page", "Page.captureScreenshot png", async () => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, s);
    const size = pngSize(Buffer.from(data, "base64"));
    return {
      status: size.width === 1280 ? "works" : "partial",
      note: `${size.width}x${size.height}`,
    };
  });

  // Input
  await check("Input", "dispatchMouseEvent click (press+release) fires onclick", async () => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send(
        "Input.dispatchMouseEvent",
        {
          type,
          x: 100,
          y: 45,
          button: type === "mouseMoved" ? "none" : "left",
          clickCount: type === "mouseMoved" ? 0 : 1,
        },
        s,
      );
    }
    const n = await evaluate(cdp, s, "document.getElementById('btn').dataset.n");
    if (n !== "1") throw new Error(`onclick count=${n}`);
  });
  await check("Input", "dispatchMouseEvent mouseMoved → mousemove", async () => {
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: 333, y: 444, button: "none" },
      s,
    );
    const v = await evaluate(cdp, s, "window.__move");
    if (v?.[0] !== 333) throw new Error(`got ${v}`);
  });
  await check("Input", "dispatchMouseEvent mouseWheel scrolls", async () => {
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 400, y: 400, deltaX: 0, deltaY: 500 },
      s,
    );
    await sleep(300);
    const v = await evaluate(cdp, s, "[scrollY, window.__wheel]");
    if (!(v[0] > 0))
      return { status: v[1] ? "partial" : "missing", note: `scrollY=${v[0]} wheelDelta=${v[1]}` };
    await evaluate(cdp, s, "scrollTo(0,0)");
    return { note: `scrollY=${v[0]}` };
  });
  await check("Input", "click focuses input; dispatchKeyEvent types", async () => {
    for (const type of ["mousePressed", "mouseReleased"])
      await cdp.send(
        "Input.dispatchMouseEvent",
        { type, x: 100, y: 115, button: "left", clickCount: 1 },
        s,
      );
    const focused = await evaluate(cdp, s, "document.activeElement?.id");
    for (const ch of "hi") {
      await cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          key: ch,
          code: `Key${ch.toUpperCase()}`,
          text: ch,
          windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
        },
        s,
      );
      await cdp.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: ch,
          code: `Key${ch.toUpperCase()}`,
          windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
        },
        s,
      );
    }
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      s,
    );
    await cdp.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      s,
    );
    const v = await evaluate(cdp, s, "[document.getElementById('inp').value, window.__keys]");
    if (focused !== "inp") return { status: "partial", note: `focus=${focused} value=${v}` };
    if (v[0] !== "h") return { status: "partial", note: `value="${v[0]}" keys=${v[1]} (want "h")` };
    return { note: `value="${v[0]}" keys=${v[1]}` };
  });
  await check("Input", "Input.insertText", async () => {
    await cdp.send("Input.insertText", { text: " wörld 😀" }, s);
    const v = await evaluate(cdp, s, "document.getElementById('inp').value");
    if (!v?.endsWith("wörld 😀")) throw new Error(`value=${v}`);
  });

  await check("Page", "javascriptDialogOpening + handleJavaScriptDialog", async () => {
    const p = cdp.waitFor(
      (e) => e.method === "Page.javascriptDialogOpening" && e.sessionId === s,
      4000,
    );
    const ev = cdp
      .send("Runtime.evaluate", { expression: "window.__c = confirm('ok?')" }, s)
      .catch(() => {});
    await p;
    await cdp.send("Page.handleJavaScriptDialog", { accept: true }, s);
    await ev;
    const v = await evaluate(cdp, s, "window.__c");
    if (v !== true) return { status: "partial", note: `confirm returned ${v}` };
  });
  await check("Page", "Page.navigatedWithinDocument (pushState)", async () => {
    const p = cdp.waitFor(
      (e) => e.method === "Page.navigatedWithinDocument" && e.sessionId === s,
      3000,
    );
    await evaluate(cdp, s, "document.getElementById('lnk').click()");
    await p;
  });
  await check("Page", "getNavigationHistory / navigateToHistoryEntry / reload", async () => {
    await navigateAndWait(cdp, s, `${fx.base}/layout.html`);
    const h = await cdp.send("Page.getNavigationHistory", {}, s);
    const prev = h.entries[h.currentIndex - 1];
    if (!prev)
      return { status: "partial", note: `entries=${h.entries.length} idx=${h.currentIndex}` };
    await cdp.send("Page.navigateToHistoryEntry", { entryId: prev.id }, s);
    await sleep(800);
    const back = await evaluate(cdp, s, "location.href");
    const t0 = cdp.events.length;
    await cdp.send("Page.reload", {}, s);
    await sleep(800);
    const reloaded = cdp.events
      .slice(t0)
      .some((e) => e.method === "Page.loadEventFired" && e.sessionId === s);
    return {
      status: back.includes("probe") && reloaded ? "works" : "partial",
      note: `entries=${h.entries.length} back→${back} reloadLoadEvent=${reloaded}`,
    };
  });

  // Screencast on an animating page
  await check(
    "Screencast",
    "Page.startScreencast + frames + acks (animating page, 3 s)",
    async () => {
      await navigateAndWait(cdp, s, `${fx.base}/anim.html`);
      let frames = 0;
      const off = cdp.on((e) => {
        if (e.method === "Page.screencastFrame" && e.sessionId === s) {
          frames++;
          cdp.send("Page.screencastFrameAck", { sessionId: e.params.sessionId }, s).catch(() => {});
        }
      });
      await cdp.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 },
        s,
      );
      await sleep(3000);
      await cdp.send("Page.stopScreencast", {}, s);
      off();
      const rafFrames = await evaluate(cdp, s, "window.__frames");
      return {
        status: frameStatus(frames),
        note: `${frames} frames in 3 s (${(frames / 3).toFixed(1)} fps); page rAF count ${rafFrames}`,
      };
    },
  );

  // Storage / isolation
  await check("Storage", "Network.setCookies / getCookies (in context A)", async () => {
    await cdp.send("Network.enable", {}, s).catch(() => {});
    await cdp.send(
      "Network.setCookies",
      { cookies: [{ name: "viaCdp", value: "1", domain: "127.0.0.1", path: "/" }] },
      s,
    );
    const { cookies } = await cdp.send("Network.getCookies", { urls: [fx.base] }, s);
    const doc = await evaluate(cdp, s, "document.cookie");
    return {
      status: cookies.some((c) => c.name === "viaCdp") ? "works" : "partial",
      note: `getCookies=${cookies.map((c) => c.name)} document.cookie="${doc}"`,
    };
  });
  await check("Storage", "Storage.getCookies / setCookies (browserContextId)", async () => {
    await cdp.send("Storage.setCookies", {
      cookies: [{ name: "viaStorage", value: "2", domain: "127.0.0.1", path: "/" }],
      browserContextId: ctxA,
    });
    const { cookies } = await cdp.send("Storage.getCookies", { browserContextId: ctxA });
    return {
      status: cookies.some((c) => c.name === "viaStorage") ? "works" : "partial",
      note: `ctxA cookies=${cookies.map((c) => c.name)}`,
    };
  });
  await check("Isolation", "contexts A/B do not share cookies or localStorage", async () => {
    await evaluate(cdp, s, "document.cookie='a=1; max-age=3600'; localStorage.setItem('k','A'); 1");
    const other = await openPage(cdp, { browserContextId: ctxB });
    await cdp.send("Page.enable", {}, other.sessionId);
    await navigateAndWait(cdp, other.sessionId, `${fx.base}/probe.html`);
    const v = await evaluate(cdp, other.sessionId, "[document.cookie, localStorage.getItem('k')]");
    await cdp.send("Target.closeTarget", { targetId: other.targetId });
    if (v[0] || v[1]) return { status: "partial", note: `B sees cookie="${v[0]}" ls=${v[1]}` };
    return { note: "B sees nothing from A" };
  });
  await check("Storage", "Network.clearBrowserCookies / Storage.clearDataForOrigin", async () => {
    await cdp
      .send("Storage.clearDataForOrigin", { origin: fx.base, storageTypes: "all" }, s)
      .catch(() => {});
    await cdp.send("Network.clearBrowserCookies", {}, s);
    const v = await evaluate(cdp, s, "document.cookie");
    return { status: v ? "partial" : "works", note: `after clear document.cookie="${v}"` };
  });

  await check("Target", "Target.closeTarget + Target.targetDestroyed", async () => {
    const p = cdp.waitFor(
      (e) => e.method === "Target.targetDestroyed" && e.params.targetId === targetId,
      3000,
    );
    await cdp.send("Target.closeTarget", { targetId });
    await p;
  });
  await check("Target", "Target.disposeBrowserContext", async () => {
    await cdp.send("Target.disposeBrowserContext", { browserContextId: ctxA });
    await cdp.send("Target.disposeBrowserContext", { browserContextId: ctxB });
  });
  await check("Browser", "Browser.close exits the process", async () => {
    await cdp.send("Browser.close").catch(() => {});
    await sleep(1500);
    try {
      process.kill(b.pid, 0);
      return { status: "partial", note: "process still alive 1.5 s after Browser.close" };
    } catch {
      return { note: "exited" };
    }
  });
} finally {
  cdp.close();
  await b.kill();
  fx.close();
  fx2.close();
}
console.log(
  JSON.stringify(
    { engine, version: b.version["Moli-Version"] ?? b.version.Browser, results },
    null,
    1,
  ),
);
