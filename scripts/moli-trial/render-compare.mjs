// Screenshots the same pages in Moli, the headless shell and Chrome at 1280x800 and diffs each
// against the headless shell with ImageMagick (pixels differing by more than 10% fuzz).
// Usage: node scripts/moli-trial/render-compare.mjs <outDir> name=url[@waitMs] ...
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, evaluate, launch, openPage, sleep } from "./lib.mjs";

const [outDir, ...specs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const pages = specs.map((spec) => {
  const [name, rest] = spec.split(/=(.*)/s);
  const [url, wait] = rest.split(/@(?=\d+$)/);
  return { name, url, wait: Number(wait ?? 1500) };
});
const engines = ["shell", "moli", "chrome"];
const report = {};

for (const engine of engines) {
  const b = await launch(engine, { moliArgs: ["--layout", "-r"] });
  const cdp = await Cdp.connect(b.wsUrl);
  try {
    for (const page of pages) {
      const { targetId, sessionId: s } = await openPage(cdp);
      await cdp.send("Page.enable", {}, s);
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
        s,
      );
      const t0 = Date.now();
      const errors = [];
      const off = cdp.on((e) => {
        if (e.sessionId === s && e.method === "Runtime.exceptionThrown")
          errors.push(e.params.exceptionDetails?.exception?.description?.slice(0, 160));
      });
      await cdp.send("Runtime.enable", {}, s);
      await cdp.send("Page.navigate", { url: page.url }, s, 30000);
      await cdp
        .waitFor((e) => e.sessionId === s && e.method === "Page.loadEventFired", 30000)
        .catch(() => {});
      const loadMs = Date.now() - t0;
      await sleep(page.wait);
      const info = await evaluate(
        cdp,
        s,
        "({title: document.title, text: document.body?.innerText?.length ?? 0, nodes: document.querySelectorAll('*').length})",
      ).catch((e) => ({ error: e.message }));
      const file = join(outDir, `${page.name}-${engine}.png`);
      const shotStart = Date.now();
      let shotError;
      try {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, s, 60000);
        writeFileSync(file, Buffer.from(data, "base64"));
      } catch (e) {
        shotError = e.message;
      }
      off();
      report[page.name] ??= {};
      report[page.name][engine] = {
        file,
        loadMs,
        shotMs: Date.now() - shotStart,
        shotError,
        ...info,
        exceptions: errors.slice(0, 3),
      };
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  } finally {
    cdp.close();
    await b.kill();
  }
}

for (const page of pages) {
  const base = join(outDir, `${page.name}-shell.png`);
  for (const engine of ["moli", "chrome"]) {
    if (report[page.name][engine]?.shotError) continue;
    const other = join(outDir, `${page.name}-${engine}.png`);
    let ae = "";
    try {
      execFileSync(
        "compare",
        [
          "-metric",
          "AE",
          "-fuzz",
          "10%",
          base,
          other,
          join(outDir, `${page.name}-${engine}-diff.png`),
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      ae = "0";
    } catch (e) {
      ae = String(e.stderr).trim();
    }
    report[page.name][engine].diffPctVsShell = +(
      (Number(ae.split(" ")[0]) / (1280 * 800)) *
      100
    ).toFixed(2);
  }
  // Side-by-side (shell | moli) at 960 px wide for reading.
  if (!report[page.name].moli?.shotError)
    execFileSync("convert", [
      base,
      join(outDir, `${page.name}-moli.png`),
      "+append",
      "-resize",
      "960x>",
      join(outDir, `${page.name}-side.webp`),
    ]);
}
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
