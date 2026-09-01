import http, { createServer, type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPaseoDaemon } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const logger = pino({ level: "silent" });
let daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
let daemonPort = 0;
let upstream: Server;
let upstreamPort = 0;
let seenHost: string | undefined;
let paseoHomeRoot = "";
let staticDir = "";
// The dev-server fixture below writes a 101 once and leaves the socket open
// (a real dev server would keep talking); closeAllConnections() doesn't
// reliably reclaim a socket hijacked via 'upgrade' and never explicitly
// closed. Same pattern as browser-preview/index.test.ts.
let upstreamUpgradeSockets: net.Socket[] = [];

function handleUpstreamUpgrade(req: IncomingMessage, socket: net.Socket): void {
  upstreamUpgradeSockets.push(socket);
  const payload = JSON.stringify(req.headers);
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Echo-Length: ${payload.length}\r\n\r\n${payload}`,
  );
  socket.on("error", () => socket.destroy());
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seenHost = req.headers.host;
    res.writeHead(200, { "content-type": "text/plain" }).end("dev-server");
  });
  upstream.on("upgrade", handleUpstreamUpgrade);
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
  // Destroy the tracked upstream-accepted sockets before stopping the
  // daemon, not after: the registered-service and preview upgrade tests
  // both leave a live piped chain (client -> daemon -> upstream), and
  // daemon.stop()'s connection draining won't finish until the upstream
  // leg closes too. Stopping the daemon first would deadlock — same
  // ordering lesson as browser-preview/index.test.ts's afterEach.
  for (const socket of upstreamUpgradeSockets) socket.destroy();
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

// Not fetch() / the `ws` package: same reason as `get` above — "host" is a
// forbidden fetch() header, so a hand-built request line over a raw socket
// is the only way to forge it. Path is deliberately not "/ws": that's the
// whole point of the defect this proves fixed (see task-5b-brief.md) — a
// preview-host upgrade on any OTHER path used to be destroyed by the
// daemon's own /ws WebSocketServer racing the preview subsystem's async
// dial to the loopback port. Sec-WebSocket-Key/Version are required here
// (unlike browser-preview/index.test.ts's equivalent helper, which never
// touches a real `ws.WebSocketServer`): this request reaches the daemon's
// real one, and ws validates the handshake headers before it ever gets to
// the path check that is the actual subject of this test — an earlier
// version of this test omitted them and failed for the wrong reason
// ("Missing or invalid Sec-WebSocket-Key header"), not the one this proves.
function upgradeThroughDaemon(
  host: string,
  reqPath: string,
): Promise<{ statusLine: string; headers: Record<string, string | undefined> }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: daemonPort }, () => {
      socket.write(
        [
          `GET ${reqPath} HTTP/1.1`,
          `Host: ${host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    let raw = "";
    let settled = false;
    function fail(reason: string) {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(reason));
    }
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
      const separator = raw.indexOf("\r\n\r\n");
      if (separator === -1) return;
      const head = raw.slice(0, separator);
      const statusLine = head.slice(0, head.indexOf("\r\n"));
      const body = raw.slice(separator + 4);
      if (!statusLine.startsWith("HTTP/1.1 101")) {
        // The failure this test exists to catch: ws's own path-based
        // shouldHandle() destroys the socket with a 400 before the preview
        // subsystem's async dial to the loopback port can complete.
        fail(`expected a 101 upgrade, got ${statusLine}: ${body}`);
        return;
      }
      const lengthMatch = /x-echo-length: (\d+)/i.exec(head);
      if (!lengthMatch || body.length < Number(lengthMatch[1])) return;
      settled = true;
      socket.destroy();
      resolve({ statusLine, headers: JSON.parse(body) });
    });
    socket.on("close", () =>
      fail(`socket closed before a response arrived (received ${JSON.stringify(raw)})`),
    );
    socket.on("error", (err) => fail(err.message));
  });
}

// The daemon's own control-plane upgrade, hand-built the same way: real
// `ws` validates Sec-WebSocket-Key/Version itself, so (unlike the preview
// fixture above) this needs a real handshake, not just Upgrade/Connection.
function upgradeControlPlane(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: daemonPort }, () => {
      socket.write(
        [
          "GET /ws HTTP/1.1",
          `Host: 127.0.0.1:${daemonPort}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    let raw = "";
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
      const eol = raw.indexOf("\r\n");
      if (eol === -1) return;
      socket.destroy();
      resolve(raw.slice(0, eol));
    });
    socket.on("error", reject);
    socket.on("close", () =>
      reject(
        new Error(
          `socket closed before any response line arrived (received ${JSON.stringify(raw)})`,
        ),
      ),
    );
  });
}

it("completes a real WebSocket handshake for a preview-host upgrade on a non-/ws path", async () => {
  const { statusLine, headers } = await upgradeThroughDaemon(
    `${upstreamPort}.preview.example.com`,
    "/hmr",
  );
  expect(statusLine).toBe("HTTP/1.1 101 Switching Protocols");
  expect(headers.host).toBe(`localhost:${upstreamPort}`);
});

it("still completes the daemon's own /ws handshake", async () => {
  const statusLine = await upgradeControlPlane();
  expect(statusLine).toBe("HTTP/1.1 101 Switching Protocols");
});

// Constraint 3 from task-5b-brief.md: an upgrade nothing claims must still
// be closed, not leaked. This host matches no preview template, isn't
// "/ws", and has no registered service route, so it falls through the
// router to service proxy's terminal passthroughUnknown:false fallback,
// which destroys the socket outright — a bare TCP close with no HTTP
// response at all, unlike ws's own abortHandshake(socket, 400). The socket
// closing IS the success condition here, mirroring
// browser-preview/index.test.ts's connectAndAwaitClose.
function expectUpgradeRejected(host: string, reqPath: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: daemonPort }, () => {
      socket.write(
        [
          `GET ${reqPath} HTTP/1.1`,
          `Host: ${host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `socket to ${host}${reqPath} was not closed within ${timeoutMs}ms — an unclaimed upgrade leaked instead of closing`,
        ),
      );
    }, timeoutMs);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.on("close", settle);
    socket.on("error", settle);
  });
}

it("closes an unclaimed upgrade instead of leaking the socket", async () => {
  await expectUpgradeRejected("nobody-home.invalid", "/whatever");
});

// The incidental fix this task also produces: before it, a
// registerWorkspaceService route reached on any path other than "/ws" was
// silently broken by the same race this task exists to fix —
// proxyUpgradeRequest's net.connect is async exactly like the preview
// subsystem's loopback dial. service-proxy.test.ts's own upgrade coverage
// (startForwardedHeadersFixture, :316-368) attaches its handler to a
// private http.Server with no competing listener, so that fixture
// structurally cannot exhibit this race — only a real, multi-listener
// createPaseoDaemon() can. x-forwarded-host (not Host, which service proxy
// forwards verbatim rather than forging — unlike the preview subsystem)
// confirms the request actually went through service proxy's own
// header-forwarding code, not some other path.
it("completes a real WebSocket handshake for a registered service route on a non-/ws path", async () => {
  const route = daemon.serviceProxy.registerWorkspaceService({
    workspaceId: "workspace-ws-upgrade",
    projectSlug: "repo",
    branchName: "main",
    scriptName: "web",
    port: upstreamPort,
  });
  const { statusLine, headers } = await upgradeThroughDaemon(
    `${route.hostname}:${daemonPort}`,
    "/hmr",
  );
  expect(statusLine).toBe("HTTP/1.1 101 Switching Protocols");
  expect(headers["x-forwarded-host"]).toBe(`${route.hostname}:${daemonPort}`);
});

async function fetchServerInfo(port: number) {
  const client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws` });
  await client.connect();
  try {
    const info = client.getLastServerInfoMessage();
    if (!info) throw new Error("daemon did not send a server_info message");
    return info;
  } finally {
    await client.close();
  }
}

it("advertises the configured template on server_info", async () => {
  const info = await fetchServerInfo(daemonPort);
  expect(info.browserPreview?.urlTemplate).toBe("https://{port}.preview.example.com");
});
