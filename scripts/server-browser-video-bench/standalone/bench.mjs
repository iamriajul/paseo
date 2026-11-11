// node bench.mjs <jpeg|tabcap|reencode> <anim|long> <exe> <new|old|headed> [secs] [codec]
import { launch } from "./cdp.mjs";
import { serve } from "./page.mjs";
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
const REPO = new URL("../../..", import.meta.url).pathname;
const { WebSocketServer } = await import(REPO + "/node_modules/ws/wrapper.mjs");
const { chromium } = await import(REPO + "/node_modules/playwright/index.mjs");
const { ScreencastHub } = await import(
  REPO + "/packages/server/src/server/server-browser/screencast-hub.ts"
);
const [method, workload, exe, mode, secsArg = "12", codec = "avc1.42E028", bitrate = "4000000"] =
  process.argv.slice(2);
const SECS = Number(secsArg);
const W = 1280,
  H = 800;
const ID = "gmmiejlmbkolphieepcebimkcgdedgom";
const pages = await serve();
const vsrv = http.createServer((q, r) => {
  r.setHeader("content-type", "text/html");
  r.end(fs.readFileSync(new URL("./viewer.html", import.meta.url)));
});
await new Promise((r) => vsrv.listen(0, "127.0.0.1", r));
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.on("listening", r));
const args = [
  `--window-size=${W},${H}`,
  "--enable-unsafe-extension-debugging",
  `--allowlisted-extension-id=${ID}`,
];
if (mode === "new") args.push("--headless=new");
else if (mode === "old") args.push("--headless");
const env = mode === "headed" ? { DISPLAY: process.env.SBV_DISPLAY || ":99" } : {};
const c = launch(exe, args, env);
const targets = new Map();
const bindings = [];
c.on((m) => {
  if (m.method === "Target.targetCreated" || m.method === "Target.targetInfoChanged")
    targets.set(m.params.targetInfo.targetId, m.params.targetInfo);
  for (const b of bindings) b(m);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitT = async (pred) => {
  for (let i = 0; i < 160; i++) {
    const v = [...targets.values()].find(pred);
    if (v) return v;
    await sleep(50);
  }
  throw new Error("no target");
};
await c.send("Target.setDiscoverTargets", { discover: true });
const { targetId } = await c.send("Target.createTarget", {
  url: `http://127.0.0.1:${pages.address().port}/${workload}`,
  ...(mode === "headed" ? { newWindow: true, background: true, width: W, height: H } : {}),
});
const { sessionId: ps } = await c.send("Target.attachToTarget", { targetId, flatten: true });
await c.send(
  "Emulation.setDeviceMetricsOverride",
  { width: W, height: H, deviceScaleFactor: 1, mobile: false },
  ps,
);
await sleep(1000);
if (workload === "long")
  await c.send(
    "Runtime.evaluate",
    {
      expression: `(function s(){scrollBy(0,6);if(scrollY+innerHeight>=document.body.scrollHeight-2)scrollTo(0,0);requestAnimationFrame(s)})()`,
    },
    ps,
  );
// viewer
const viewer = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
const vpage = await viewer.newPage({ viewport: { width: 1300, height: 820 } });
const sockP = new Promise((r) => wss.once("connection", r));
await vpage.goto(
  `http://127.0.0.1:${vsrv.address().port}/?ws=ws://127.0.0.1:${wss.address().port}&codec=${encodeURIComponent(method === "reencode" ? "avc1.42E028" : codec)}`,
);
const ws = await sockP;
let sentBytes = 0;
const sendBin = (buf) => {
  sentBytes += buf.length;
  ws.send(buf);
};
let onText = () => {};
ws.on("message", (d, isBin) => {
  if (!isBin) onText(d.toString());
});
let ff = null;
const extraPids = [];
if (method === "jpeg") {
  const hub = new ScreencastHub({
    start: (s) =>
      c.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 60,
          maxWidth: s.maxWidth,
          maxHeight: s.maxHeight,
          everyNthFrame: 1,
        },
        ps,
      ),
    stop: () => c.send("Page.stopScreencast", {}, ps),
  });
  bindings.push((m) => {
    if (m.method === "Page.screencastFrame" && m.sessionId === ps) {
      const jpeg = Buffer.from(m.params.data, "base64");
      hub.pushFrame(
        { jpeg, width: m.params.metadata.deviceWidth, height: m.params.metadata.deviceHeight },
        () => c.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, ps),
      );
    }
  });
  onText = (t) => {
    if (t.startsWith("ack:")) hub.ack("v", Number(t.slice(4)));
  };
  hub.addViewer(
    "v",
    {
      send: (f, seq) => {
        const h = Buffer.alloc(5);
        h[0] = 1;
        h.writeUInt32BE(seq, 1);
        sendBin(Buffer.concat([h, f.jpeg]));
      },
      isCongested: () => ws.bufferedAmount > 1 << 20,
    },
    { maxWidth: W, maxHeight: H },
  );
} else if (method === "reencode") {
  ff = spawn(
    "nice",
    [
      "-n",
      "10",
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-f",
      "mjpeg",
      "-i",
      "pipe:0",
      "-an",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "baseline",
      "-pix_fmt",
      "yuv420p",
      "-x264-params",
      "aud=1:keyint=600",
      "-b:v",
      String(bitrate),
      "-maxrate",
      String(bitrate),
      "-bufsize",
      String(bitrate / 4),
      "-flush_packets",
      "1",
      "-f",
      "h264",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  extraPids.push(ff.pid);
  let acc = Buffer.alloc(0);
  const emit = (au) => {
    if (!au.length) return;
    let key = false;
    for (let i = 0; i + 4 < au.length; i++)
      if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 5) {
        key = true;
        break;
      }
    sendBin(Buffer.concat([Buffer.from([key ? 2 : 3]), au]));
  };
  ff.stdout.on("data", (d) => {
    acc = Buffer.concat([acc, d]);
    const starts = [];
    for (let i = 0; i + 4 < acc.length; i++)
      if (
        acc[i] === 0 &&
        acc[i + 1] === 0 &&
        acc[i + 2] === 0 &&
        acc[i + 3] === 1 &&
        (acc[i + 4] & 0x1f) === 9
      )
        starts.push(i);
    starts.push(acc.length);
    for (let k = 0; k + 1 < starts.length; k++) emit(acc.subarray(starts[k], starts[k + 1]));
    acc = Buffer.alloc(0);
  });
  bindings.push((m) => {
    if (m.method === "Page.screencastFrame" && m.sessionId === ps) {
      ff.stdin.write(Buffer.from(m.params.data, "base64"));
      c.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, ps);
    }
  });
  await c.send(
    "Page.startScreencast",
    { format: "jpeg", quality: 60, maxWidth: W, maxHeight: H, everyNthFrame: 1 },
    ps,
  );
} else {
  await c.send("Extensions.loadUnpacked", { path: new URL("./ext", import.meta.url).pathname });
  const sw = await waitT((t) => t.type === "service_worker" && t.url.includes(ID));
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
    await sleep(100);
  }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  const off = await waitT((t) => t.url.includes("offscreen.html"));
  const { sessionId: os } = await c.send("Target.attachToTarget", {
    targetId: off.targetId,
    flatten: true,
  });
  await c.send("Runtime.addBinding", { name: "__paseoVideo" }, os);
  let dropping = false;
  bindings.push((m) => {
    if (m.method === "Runtime.bindingCalled" && m.sessionId === os) {
      const d = JSON.parse(m.params.payload);
      if (d.err) {
        console.error("enc err", d.err);
        return;
      }
      const key = d.t === "key";
      if (key) dropping = false;
      if (!key && (dropping || ws.bufferedAmount > 1 << 20)) {
        if (!dropping) c.send("Runtime.evaluate", { expression: `paseoKey("t1")` }, os);
        dropping = true;
        return;
      }
      sendBin(Buffer.concat([Buffer.from([key ? 2 : 3]), Buffer.from(d.d, "base64")]));
    }
  });
  onText = (t) => {
    if (t === "key") c.send("Runtime.evaluate", { expression: `paseoKey("t1")` }, os);
  };
  const s = await c.send(
    "Runtime.evaluate",
    {
      expression: `paseoStart("t1", ${JSON.stringify(r.result.value)}, {width:${W},height:${H},fps:60,bitrate:${bitrate},codec:${JSON.stringify(codec)}})`,
      awaitPromise: true,
      returnByValue: true,
    },
    os,
  );
  if (s.exceptionDetails) throw new Error(s.exceptionDetails.exception?.description);
}
// CPU accounting over the measurement window
const tree = (root) => {
  const all = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  const ppid = {};
  for (const p of all) {
    try {
      const st = fs.readFileSync(`/proc/${p}/stat`, "utf8");
      ppid[p] = st.slice(st.lastIndexOf(")") + 2).split(" ")[1];
    } catch {}
  }
  const out = new Set([String(root)]);
  let grown = true;
  while (grown) {
    grown = false;
    for (const [p, pp] of Object.entries(ppid))
      if (out.has(pp) && !out.has(p)) {
        out.add(p);
        grown = true;
      }
  }
  return [...out];
};
const ticks = (pids) =>
  pids.reduce((s, p) => {
    try {
      const f = fs
        .readFileSync(`/proc/${p}/stat`, "utf8")
        .slice(fs.readFileSync(`/proc/${p}/stat`, "utf8").lastIndexOf(")") + 2)
        .split(" ");
      return s + Number(f[11]) + Number(f[12]);
    } catch {
      return s;
    }
  }, 0);

await sleep(2500); // warm-up
const srcPids = tree(c.proc.pid);
const vPids = tree(process.pid).filter(
  (p) => p !== String(process.pid) && !srcPids.includes(p) && !extraPids.map(String).includes(p),
);
await vpage.evaluate(() => {
  stats.lat = [];
  stats.perSec = {};
  stats.frames = 0;
});
const t0 = Date.now(),
  b0 = sentBytes,
  cs0 = ticks(srcPids),
  cv0 = ticks(vPids),
  cf0 = ticks(extraPids),
  n0 = process.cpuUsage();
await sleep(SECS * 1000);
const el = (Date.now() - t0) / 1000,
  cs1 = ticks(srcPids),
  cv1 = ticks(vPids),
  cf1 = ticks(extraPids),
  n1 = process.cpuUsage(n0);
const st = await vpage.evaluate(() => stats);
const secsKeys = Object.keys(st.perSec).map(Number).sort();
const full = secsKeys.slice(1, -1).map((k) => st.perSec[k]);
const lat = st.lat.sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
const load = fs.readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
const res = {
  method,
  workload,
  exe: exe.split("/").pop(),
  mode,
  codec: { tabcap: codec, reencode: "x264", jpeg: "jpeg q60" }[method],
  fpsWorst: Math.min(...full),
  fpsMed: full.sort((a, b) => a - b)[Math.floor(full.length / 2)],
  latP50: q(0.5),
  latP99: q(0.99),
  kbps: Math.round(((sentBytes - b0) * 8) / el / 1000),
  srcChromeCpu: Math.round((cs1 - cs0) / el),
  daemonCpu: Math.round((n1.user + n1.system) / 1e4 / el) + Math.round((cf1 - cf0) / el),
  viewerCpu: Math.round((cv1 - cv0) / el),
  load,
  errors: st.errors.slice(0, 2),
};
console.log(JSON.stringify(res));
fs.appendFileSync(
  process.env.SBV_RESULTS ?? "/tmp/sbv-results.jsonl",
  JSON.stringify({ at: new Date().toISOString(), ...res }) + "\n",
);
ff?.kill();
c.close();
await viewer.close();
wss.close();
vsrv.close();
pages.close();
process.exit(0);
