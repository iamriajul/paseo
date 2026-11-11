// Serves the exported web app from its own origin, so it reaches the daemon only through a pairing offer.
// node static.mjs <dir> <port>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const [dir, port] = process.argv.slice(2);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};
http
  .createServer((req, res) => {
    let file = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(dir, "index.html");
    res.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`static ${dir} on ${port}`));
