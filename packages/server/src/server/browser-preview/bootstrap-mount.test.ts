import http, { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPaseoDaemon } from "../bootstrap.js";

const logger = pino({ level: "silent" });
let daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
let daemonPort = 0;
let upstream: Server;
let upstreamPort = 0;
let seenHost: string | undefined;
let paseoHomeRoot = "";
let staticDir = "";

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seenHost = req.headers.host;
    res.writeHead(200, { "content-type": "text/plain" }).end("dev-server");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const addr = upstream.address();
  if (addr === null || typeof addr === "string") throw new Error("upstream did not bind a port");
  upstreamPort = addr.port;

  paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-preview-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));

  daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      // Deliberately restrictive: proves preview hosts bypass the allowlist
      // because a handled request never calls next() to reach it.
      hostnames: [],
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
      browserPreviewUrlTemplate: "https://{port}.preview.example.com",
      // Without a configured publicBaseUrl, classifyHost's known-service-miss
      // branch never triggers for *.preview.example.com, so the ordering bug
      // this test exists to catch would go unnoticed. With it, a preview host
      // ends with the configured base and collides with that branch exactly
      // the way a real public-base deployment would.
      serviceProxy: { publicBaseUrl: "https://example.com", standaloneListen: null },
    },
    logger,
  );
  await daemon.start();
  const target = daemon.getListenTarget();
  if (!target || target.type !== "tcp") {
    throw new Error("daemon did not bind a TCP listen target");
  }
  daemonPort = target.port;
});

afterAll(async () => {
  await daemon.stop();
  await new Promise((resolve) => upstream.close(resolve));
  await rm(paseoHomeRoot, { recursive: true, force: true });
  await rm(staticDir, { recursive: true, force: true });
});

// Not fetch(): "host" is a forbidden request header there, so the real socket
// authority (127.0.0.1:<daemonPort>) always wins and every Host-routing
// assertion below would either fail outright or pass vacuously. http.request
// has no such restriction — same pattern as browser-preview/index.test.ts.
function get(reqPath: string, host: string): Promise<{ status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: daemonPort,
        path: reqPath,
        headers: { host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            text: async () => Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

it("routes a preview Host to the loopback port with Host forged, ahead of the service proxy's known-service-miss 404", async () => {
  const res = await get("/", `${upstreamPort}.preview.example.com`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("dev-server");
  expect(seenHost).toBe(`localhost:${upstreamPort}`);
});

it("still rejects a non-preview host that is not in the allowlist", async () => {
  const res = await get("/api/health", "evil.invalid");
  expect(res.status).toBe(403);
});
