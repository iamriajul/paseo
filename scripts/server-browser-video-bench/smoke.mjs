// Asks the bench daemon for a video stream of a tab and counts what arrives (no decoding).
// node scripts/server-browser-video-bench/smoke.mjs <daemonPort> [url]
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const REPO = path.resolve(import.meta.dirname, "../..");
const { WebSocket } = await import(
  pathToFileURL(path.join(REPO, "node_modules/ws/wrapper.mjs")).href
);
const { DaemonClient } = await import(
  pathToFileURL(path.join(REPO, "packages/client/dist/daemon-client.js")).href
);
const [port, url = "https://example.com/"] = process.argv.slice(2);
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  clientId: `smoke-${randomUUID()}`,
  clientType: "cli",
  appVersion: JSON.parse(fs.readFileSync(path.join(REPO, "packages/app/package.json"), "utf8"))
    .version,
  webSocketFactory: (u, o) => new WebSocket(u, { headers: o?.headers }),
});
await client.connect();
fs.mkdirSync("/tmp/sbv/bench-workspace", { recursive: true });
const ws = await client.createWorkspace({
  source: { kind: "directory", path: "/tmp/sbv/bench-workspace" },
});
const browserId = await client.serverBrowserOpenTab(ws.workspace.id, url);
let jpeg = 0,
  chunks = 0,
  keys = 0,
  bytes = 0,
  first = null;
const perSec = {};
let askedAt = 0;
let keyAfterAsk = null;
const sub = client.observeServerBrowserScreencast(
  { browserId, maxWidth: 1280, maxHeight: 800 },
  (f) => {
    const second = Math.floor(Date.now() / 1000);
    perSec[second] = (perSec[second] ?? "") + "j";
    jpeg++;
    f.ack();
  },
  {
    video: {
      codecs:
        process.env.SMOKE_CODECS === undefined
          ? ["avc1.42E028", "vp8"]
          : process.env.SMOKE_CODECS.split(",").filter(Boolean),
      onChunk: (c) => {
        chunks++;
        const second = Math.floor(Date.now() / 1000);
        perSec[second] = (perSec[second] ?? "") + (c.key ? "K" : ".");
        bytes += c.data.length;
        if (c.key) keys++;
        if (!first) first = [...c.data.subarray(0, 6)];
        // Once, mid-stream: the viewer asks for a keyframe (0x43) and one should follow.
        if (chunks === 60) {
          askedAt = chunks;
          c.requestKeyframe();
        } else if (askedAt && c.key && keyAfterAsk === null) keyAfterAsk = chunks - askedAt;
        c.ack();
      },
    },
  },
);
sub.subscribe({ snapshot: (s) => console.log("response", JSON.stringify(s)), update: () => {} });
await new Promise((r) => setTimeout(r, 6000));
console.log({
  jpeg,
  chunks,
  keys,
  kB: Math.round(bytes / 1024),
  first,
  keyAfterAsk,
  perSec: Object.values(perSec)
    .map((marks) => `${marks.length}${marks.includes("K") ? "K" : ""}`)
    .join(" "),
});
await sub.release();
await client.serverBrowserCloseTab(browserId);
await client.close();
process.exit(0);
