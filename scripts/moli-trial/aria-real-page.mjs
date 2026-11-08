// Runs the engine's real ARIA snapshot script on a page and prints its size, roles and names,
// to compare what an agent would see in each engine. Usage: node aria-real-page.mjs <engine> <url>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, evaluate, launch, navigateAndWait, openPage, sleep } from "./lib.mjs";

const here = new URL(".", import.meta.url).pathname;
const src = readFileSync(
  join(here, "../../packages/server/src/server/server-browser/engine/aria-snapshot-script.ts"),
  "utf8",
);
const marker = /ARIA_SNAPSHOT_SCRIPT_MARKER = "([^"]+)"/.exec(src)[1];
const script = /String\.raw`([\s\S]*)`;\s*$/m
  .exec(src)[1]
  .replace("${JSON.stringify(ARIA_SNAPSHOT_SCRIPT_MARKER)}", JSON.stringify(marker));
const [engine, url, wait = "8000"] = process.argv.slice(2);
const b = await launch(engine, { moliArgs: ["--layout", "-r"] });
const cdp = await Cdp.connect(b.wsUrl);
try {
  const { sessionId: s } = await openPage(cdp);
  await cdp.send("Page.enable", {}, s);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    s,
  );
  await navigateAndWait(cdp, s, url);
  await sleep(Number(wait));
  const snap = await evaluate(cdp, s, script);
  const text = typeof snap === "string" ? snap : JSON.stringify(snap);
  if (process.env.DUMP) console.log(text.slice(0, 1500));
  const roles = {};
  for (const m of text.matchAll(/"role":"([a-z]+)"/g)) roles[m[1]] = (roles[m[1]] ?? 0) + 1;
  const names = [...text.matchAll(/"name":"([^"]{1,40})"/g)].map((m) => m[1]);
  const texts = [...text.matchAll(/"text":"([^"]{1,40})"/g)].map((m) => m[1]);
  console.log(
    JSON.stringify({
      engine,
      url,
      chars: text.length,
      roles,
      names: names.slice(0, 20),
      texts: texts.slice(0, 15),
    }),
  );
} finally {
  cdp.close();
  await b.kill();
}
