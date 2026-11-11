import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
export function launch(exe, args, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sbv-prof-"));
  const p = spawn(
    "nice",
    [
      "-n",
      "10",
      exe,
      "--remote-debugging-pipe",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--mute-audio",
      "--hide-scrollbars",
      ...args,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: { ...process.env, ...env } },
  );
  p.stderr.on("data", (d) => {
    if (process.env.CHROME_LOG) process.stderr.write(d);
  });
  const w = p.stdio[3],
    r = p.stdio[4];
  let id = 0;
  const pend = new Map();
  const listeners = [];
  let buf = Buffer.alloc(0);
  r.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(0)) >= 0) {
      const m = JSON.parse(buf.subarray(0, i).toString());
      buf = buf.subarray(i + 1);
      if (m.id && pend.has(m.id)) {
        const { res, rej } = pend.get(m.id);
        pend.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      } else for (const l of listeners) l(m);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const i = ++id;
      pend.set(i, { res, rej });
      w.write(JSON.stringify({ id: i, method, params, sessionId }) + "\0");
    });
  return { proc: p, send, on: (f) => listeners.push(f), close: () => p.kill("SIGKILL") };
}
