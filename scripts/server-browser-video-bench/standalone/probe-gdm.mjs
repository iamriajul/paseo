import { launch } from "./cdp.mjs";
import { serve } from "./page.mjs";
const [exe, mode = "old", ...extra] = process.argv.slice(2);
const args = ["--window-size=1280,800", ...extra];
if (mode === "new") args.push("--headless=new");
else if (mode === "old") args.push("--headless");
const srv = await serve();
const url = `http://127.0.0.1:${srv.address().port}/anim`;
const c = launch(exe, args);
let n = 0,
  bytes = 0,
  first = 0;
c.on((m) => {
  if (m.method === "Runtime.bindingCalled") {
    const d = JSON.parse(m.params.payload);
    if (d.err) console.log("ERR", d.err);
    else {
      if (!first) first = Date.now();
      n++;
      bytes += d.len;
    }
  }
});
try {
  const { targetId } = await c.send("Target.createTarget", { url });
  const { sessionId: s } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  await new Promise((resolve) => setTimeout(resolve, 800));
  await c.send("Runtime.addBinding", { name: "__v" }, s);
  const r = await c.send(
    "Runtime.evaluate",
    {
      userGesture: true,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async()=>{
    const info = { gdm: !!navigator.mediaDevices?.getDisplayMedia, mstp: typeof MediaStreamTrackProcessor, ve: typeof VideoEncoder };
    const m = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60, width: 1280, height: 800 }, preferCurrentTab: true, selfBrowserSurface: "include" });
    const tr = m.getVideoTracks()[0]; info.settings = tr.getSettings();
    const enc = new VideoEncoder({ output: (c) => __v(JSON.stringify({ len: c.byteLength })), error: (e) => __v(JSON.stringify({ err: String(e) })) });
    let cfg = false; const rd = new MediaStreamTrackProcessor({ track: tr }).readable.getReader();
    (async () => { for (;;) { const { value: f } = await rd.read(); if (!cfg) { enc.configure({ codec: "avc1.42E028", width: f.codedWidth & ~1, height: f.codedHeight & ~1, bitrate: 4e6, framerate: 60, latencyMode: "realtime", avc: { format: "annexb" } }); cfg = true; }
      if (enc.encodeQueueSize > 2) { f.close(); continue; } enc.encode(f); f.close(); } })();
    return info; })()`,
    },
    s,
  );
  console.log(JSON.stringify(r.exceptionDetails?.exception?.description ?? r.result?.value));
  await new Promise((resolve) => setTimeout(resolve, 4000));
  console.log(`chunks=${n} fps=${(n / ((Date.now() - first) / 1000)).toFixed(1)}`);
} catch (e) {
  console.log("FAIL", e.message);
} finally {
  c.close();
  srv.close();
}
