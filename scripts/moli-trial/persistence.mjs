// Does a profile keep cookies and localStorage across a restart? Tries three ways to stop the
// browser: Browser.close (waiting for a clean exit), SIGTERM, and SIGKILL after a 3 s idle.
// Usage: node scripts/moli-trial/persistence.mjs <engine>
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp, evaluate, launch, navigateAndWait, openPage, serveFixtures, sleep } from "./lib.mjs";

const engine = process.argv[2] ?? "moli";
const here = new URL(".", import.meta.url).pathname;
const fx = await serveFixtures(join(here, "fixtures"));
const out = {};
async function session(profileDir, fn) {
  const b = await launch(engine, { profileDir, moliArgs: ["--layout"] });
  const cdp = await Cdp.connect(b.wsUrl);
  const { sessionId: s } = await openPage(cdp);
  await cdp.send("Page.enable", {}, s);
  await navigateAndWait(cdp, s, `${fx.base}/probe.html`);
  return fn(cdp, s, b);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
for (const mode of ["Browser.close", "SIGTERM", "SIGKILL after 3 s"]) {
  const profileDir = mkdtempSync(join(tmpdir(), `persist-${engine}-`));
  await session(profileDir, async (cdp, s, b) => {
    await evaluate(
      cdp,
      s,
      "document.cookie = 'session=abc; max-age=3600'; localStorage.setItem('token', 'xyz'); 1",
    );
    const t0 = Date.now();
    if (mode === "Browser.close") await cdp.send("Browser.close").catch(() => {});
    else if (mode === "SIGTERM") process.kill(b.pid, "SIGTERM");
    else {
      await sleep(3000);
      process.kill(-b.pid, "SIGKILL");
    }
    while (alive(b.pid) && Date.now() - t0 < 10000) await sleep(50);
    out[mode] = { exitMs: Date.now() - t0 };
    cdp.close();
    await b.kill();
  });
  await session(profileDir, async (cdp, s, b) => {
    out[mode].after = await evaluate(cdp, s, "[document.cookie, localStorage.getItem('token')]");
    cdp.close();
    await b.kill();
  });
  rmSync(profileDir, { recursive: true, force: true });
}
fx.close();
console.log(JSON.stringify({ engine, ...out }));
