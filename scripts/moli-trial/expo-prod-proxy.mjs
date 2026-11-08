// Proxies Expo web (dev server) and rewrites the entry bundle URL to dev=false&minify=true, so a
// browser loads Paseo's app as a production-size bundle instead of the 55 MB dev bundle.
// Usage: node scripts/moli-trial/expo-prod-proxy.mjs <listenPort> <expoPort>
import http from "node:http";
const [listen, upstream] = process.argv.slice(2).map(Number);
http
  .createServer(async (req, res) => {
    const url = `http://127.0.0.1:${upstream}${req.url.replace("dev=true", "dev=false&minify=true")}`;
    const r = await fetch(url, { headers: { accept: req.headers.accept ?? "*/*" } });
    const type = r.headers.get("content-type") ?? "";
    res.statusCode = r.status;
    res.setHeader("content-type", type);
    if (type.includes("text/html"))
      res.end((await r.text()).replaceAll("dev=true", "dev=false&amp;minify=true"));
    else res.end(Buffer.from(await r.arrayBuffer()));
  })
  .listen(listen, "127.0.0.1");
