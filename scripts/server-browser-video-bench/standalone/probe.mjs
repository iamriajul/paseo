import { launch } from "./cdp.mjs";
import { serve } from "./page.mjs";
const [exe, mode = "new", codec = "avc1.42E028"] = process.argv.slice(2);
const EXT = new URL("./ext", import.meta.url).pathname,
  ID = "gmmiejlmbkolphieepcebimkcgdedgom";
const args = [
  "--enable-unsafe-extension-debugging",
  `--allowlisted-extension-id=${ID}`,
  "--window-size=1280,800",
];
if (mode === "new") args.push("--headless=new");
else if (mode === "old") args.push("--headless");
const srv = await serve();
const url = `http://127.0.0.1:${srv.address().port}/anim`;
const c = launch(exe, args);
const targets = new Map();
c.on((m) => {
  if (m.method === "Target.targetCreated" || m.method === "Target.targetInfoChanged")
    targets.set(m.params.targetInfo.targetId, m.params.targetInfo);
  if (m.method === "Runtime.bindingCalled") onChunk(JSON.parse(m.params.payload));
});
const wait = async (pred, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = [...targets.values()].find(pred);
    if (v) return v;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    "timeout waiting target " + [...targets.values()].map((t) => t.type + " " + t.url).join(", "),
  );
};
let n = 0,
  bytes = 0,
  first = 0,
  keys = 0;
function onChunk(m) {
  if (m.err) {
    console.log("ERR", m.err);
    return;
  }
  if (m.cfg) console.log("cfg", m.cfg, m.w, m.h);
  if (!first) first = Date.now();
  n++;
  bytes += m.d.length * 0.75;
  if (m.t === "key") keys++;
}
try {
  await c.send("Target.setDiscoverTargets", { discover: true });
  console.log("load", await c.send("Extensions.loadUnpacked", { path: EXT }));
  const { targetId } = await c.send("Target.createTarget", { url });
  const sw = await wait((t) => t.type === "service_worker" && t.url.includes(ID));
  const { sessionId: sws } = await c.send("Target.attachToTarget", {
    targetId: sw.targetId,
    flatten: true,
  });
  await c.send("Runtime.runIfWaitingForDebugger", {}, sws).catch(() => {});
  let r;
  for (let i = 0; i < 40; i++) {
    r = await c.send(
      "Runtime.evaluate",
      {
        expression: `typeof paseoStreamId === "function" ? paseoStreamId(${JSON.stringify(targetId)}) : "__notyet"`,
        awaitPromise: true,
        returnByValue: true,
      },
      sws,
    );
    if (r.result?.value !== "__notyet") break;
    await new Promise((q) => setTimeout(q, 100));
  }
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  const streamId = r.result.value;
  console.log("streamId ok", streamId.slice(0, 12));
  const off = await wait((t) => t.url.includes("offscreen.html"));
  const { sessionId: os } = await c.send("Target.attachToTarget", {
    targetId: off.targetId,
    flatten: true,
  });
  await c.send("Runtime.addBinding", { name: "__paseoVideo" }, os);
  const s = await c.send(
    "Runtime.evaluate",
    {
      expression: `paseoStart("t1", ${JSON.stringify(streamId)}, {width:1280,height:800,fps:60,bitrate:4000000,codec:${JSON.stringify(codec)}})`,
      awaitPromise: true,
      returnByValue: true,
    },
    os,
  );
  if (s.exceptionDetails)
    throw new Error(
      JSON.stringify(s.exceptionDetails.exception?.description || s.exceptionDetails),
    );
  console.log("settings", JSON.stringify(s.result.value));
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const secs = (Date.now() - first) / 1000;
  console.log(
    `chunks=${n} fps=${(n / secs).toFixed(1)} kbps=${((bytes * 8) / secs / 1000).toFixed(0)} keys=${keys}`,
  );
  // navigation survival
  const { sessionId: ps } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  await c.send("Page.navigate", { url: url.replace("anim", "anim?2") }, ps);
  n = 0;
  bytes = 0;
  first = 0;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log(`after nav chunks=${n}`);
} catch (e) {
  console.log("FAIL", e.message);
} finally {
  c.close();
  srv.close();
}
