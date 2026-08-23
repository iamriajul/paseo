import http, { createServer, type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import express from "express";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserPreviewSubsystem } from "./index.js";
import { parseBrowserPreviewTemplate } from "./url-template.js";

const logger = pino({ level: "silent" });

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function isForwardedHeader(name: string): boolean {
  return name.startsWith("x-forwarded");
}

describe("createBrowserPreviewSubsystem", () => {
  let upstream: Server;
  let proxy: Server;
  let upstreamPort = 0;
  let proxyPort = 0;
  let seenHost: string | undefined;
  let seenOrigin: string | undefined;

  beforeEach(async () => {
    upstream = createServer((req, res) => {
      seenHost = req.headers.host;
      seenOrigin = req.headers.origin;
      if (req.url === "/redirect") {
        res.writeHead(302, { location: `http://localhost:${upstreamPort}/landed` });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/plain",
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
      });
      res.end("upstream-body");
    });
    upstreamPort = await listen(upstream);

    const app = express();
    const template = parseBrowserPreviewTemplate("https://{port}.preview.example.com");
    const subsystem = createBrowserPreviewSubsystem({ template, logger });
    app.use(subsystem.middleware());
    app.use((_req, res) => res.status(418).send("fell-through"));
    proxy = createServer(app);
    proxyPort = await listen(proxy);
  });

  afterEach(async () => {
    await new Promise((r) => upstream.close(r));
    await new Promise((r) => proxy.close(r));
  });

  // Not fetch(): "host" is a forbidden request header there, so the real
  // socket authority always wins and every Host-routing assertion below
  // would either fail outright or pass vacuously. http.request has no such
  // restriction — same pattern as httpGet in service-proxy.test.ts. The
  // shape stays fetch-Response-like so the test bodies below are unchanged.
  function get(
    path: string,
    host: string,
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: proxyPort,
          path,
          headers: { host, origin: "https://app.example.com" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: {
                get(name: string) {
                  const value = res.headers[name.toLowerCase()];
                  if (value === undefined) return null;
                  return Array.isArray(value) ? value.join(", ") : value;
                },
              },
              text: async () => Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("proxies a matching host to the loopback port", async () => {
    const res = await get("/", `${upstreamPort}.preview.example.com`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-body");
  });

  it("forges Host as localhost:<port> and drops Origin", async () => {
    await get("/", `${upstreamPort}.preview.example.com`);
    expect(seenHost).toBe(`localhost:${upstreamPort}`);
    expect(seenOrigin).toBeUndefined();
  });

  it("does not set X-Forwarded headers", async () => {
    let forwarded: string[] = [];
    const probe = createServer((req, res) => {
      forwarded = Object.keys(req.headers).filter(isForwardedHeader);
      res.writeHead(200).end("ok");
    });
    const probePort = await listen(probe);
    await get("/", `${probePort}.preview.example.com`);
    expect(forwarded).toEqual([]);
    await new Promise((r) => probe.close(r));
  });

  it("strips framing headers from the response", async () => {
    const res = await get("/", `${upstreamPort}.preview.example.com`);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("rewrites a loopback redirect onto the preview origin", async () => {
    const res = await get("/redirect", `${upstreamPort}.preview.example.com`);
    expect(res.headers.get("location")).toBe(`https://${upstreamPort}.preview.example.com/landed`);
  });

  it("calls next() for hosts that do not match the template", async () => {
    const res = await get("/", "daemon-1.studio.example.com");
    expect(res.status).toBe(418);
  });

  it("returns 502 when the loopback port is not listening", async () => {
    const res = await get("/", "9.preview.example.com");
    expect(res.status).toBe(502);
  });

  it("calls next() for every host when no template is configured", async () => {
    const app = express();
    const subsystem = createBrowserPreviewSubsystem({ template: null, logger });
    app.use(subsystem.middleware());
    app.use((_req, res) => res.status(418).send("fell-through"));
    const bare = createServer(app);
    const barePort = await listen(bare);
    const res = await fetch(`http://127.0.0.1:${barePort}/`, {
      headers: { host: `${upstreamPort}.preview.example.com` },
    });
    expect(res.status).toBe(418);
    await new Promise((r) => bare.close(r));
  });
});

// The brief's test suite above only exercises middleware(). upgradeHandler()
// is the other half of the interface and gets none of that coverage, so it's
// covered independently here: a matching WS upgrade must reach the upstream
// with the handshake headers intact (buildUpstreamHeaders strips connection/
// upgrade as hop-by-hop; the upgrade path has to put them back or the dev
// server never recognizes the request as an upgrade at all), and a
// non-matching host must leave the socket untouched for the next 'upgrade'
// listener.
//
// Not covered here: the socket.on("end"/"close", abandon) guard in
// upgradeHandler() that destroys a still-pending upstream dial when the
// client disconnects first. It's implemented (see the comments at its call
// site) and its core mechanism — an http.Server socket needs "end" handled
// explicitly, not just "close", because allowHalfOpen never auto-closes the
// write side on a peer's FIN — was verified against plain Node scripts
// outside vitest. But the exact two-hop propagation this guard depends on
// (client → this socket → upstream.destroy() → the dev server noticing)
// was not reliably observable even in a minimal bare-Node reproduction of
// the same shape, likely an http.Agent/socket-lifecycle interaction; no
// black-box test in this file could be made to pass without being flaky.
describe("createBrowserPreviewSubsystem upgradeHandler", () => {
  let wsUpstream: Server;
  let wsUpstreamPort = 0;
  let proxy: Server;
  let proxyPort = 0;
  // wsUpstream writes its 101 response once and then leaves the socket open
  // (a real dev server would keep talking; this fixture doesn't need to) —
  // closeAllConnections() doesn't reliably reclaim a socket hijacked via
  // 'upgrade' and never explicitly closed. Same pattern and reason as
  // startForwardedHeadersFixture in service-proxy.test.ts.
  let wsUpstreamSockets: net.Socket[] = [];

  function handleWsUpstreamUpgrade(req: IncomingMessage, socket: net.Socket) {
    wsUpstreamSockets.push(socket);
    const payload = JSON.stringify(req.headers);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Echo-Length: ${payload.length}\r\n\r\n${payload}`,
    );
    socket.on("error", () => socket.destroy());
  }

  beforeEach(async () => {
    wsUpstreamSockets = [];
    wsUpstream = createServer((_req, res) => {
      // Reached only if the handshake headers got lost on the way upstream:
      // proves the failure via a distinct status rather than a hang.
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not-an-upgrade");
    });
    wsUpstream.on("upgrade", handleWsUpstreamUpgrade);
    wsUpstreamPort = await listen(wsUpstream);

    const app = express();
    const template = parseBrowserPreviewTemplate("https://{port}.preview.example.com");
    const subsystem = createBrowserPreviewSubsystem({ template, logger });
    app.use(subsystem.middleware());
    proxy = createServer(app);
    proxy.on("upgrade", subsystem.upgradeHandler());
    proxyPort = await listen(proxy);
  });

  afterEach(async () => {
    // Destroy every tracked socket, on both servers, before awaiting either
    // close(): proxy's downstream socket only fully closes once the upstream
    // leg it's piped to closes too, and that leg only closes once
    // wsUpstream's own accepted socket closes. Awaiting proxy.close() first
    // would deadlock — it can't finish until a step that hasn't run yet.
    proxy.closeAllConnections();
    for (const socket of wsUpstreamSockets) socket.destroy();
    wsUpstream.closeAllConnections();
    await Promise.all([
      new Promise((r) => proxy.close(r)),
      new Promise((r) => wsUpstream.close(r)),
    ]);
  });

  function upgradeThroughProxy(host: string): Promise<{
    statusLine: string;
    headers: Record<string, string | undefined>;
  }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: proxyPort }, () => {
        socket.write(
          [
            "GET /ws HTTP/1.1",
            `Host: ${host}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Origin: https://app.example.com",
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
        reject(new Error(`${reason} (received ${raw.length} bytes)`));
      }
      socket.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
        const separator = raw.indexOf("\r\n\r\n");
        if (separator === -1) return;
        const head = raw.slice(0, separator);
        const lengthMatch = /x-echo-length: (\d+)/i.exec(head);
        const body = raw.slice(separator + 4);
        if (!lengthMatch || body.length < Number(lengthMatch[1])) return;
        settled = true;
        socket.destroy();
        resolve({ statusLine: head.slice(0, head.indexOf("\r\n")), headers: JSON.parse(body) });
      });
      // Without these the promise stays pending forever when the proxy drops
      // the upgrade, and the test reports a timeout instead of the real failure.
      socket.on("close", () => fail("socket closed before the echo arrived"));
      socket.on("error", (err) => fail(err.message));
    });
  }

  function readStatusLine(host: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: proxyPort }, () => {
        socket.write(
          [
            "GET /ws HTTP/1.1",
            `Host: ${host}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
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
      socket.on("close", () => reject(new Error("socket closed before any response line arrived")));
    });
  }

  it("completes the WebSocket handshake and forges the upstream request", async () => {
    const { statusLine, headers } = await upgradeThroughProxy(
      `${wsUpstreamPort}.preview.example.com`,
    );
    expect(statusLine).toBe("HTTP/1.1 101 Switching Protocols");
    expect(headers.host).toBe(`localhost:${wsUpstreamPort}`);
    expect(headers.origin).toBeUndefined();
    expect(headers.connection).toBe("Upgrade");
    expect(headers.upgrade).toBe("websocket");
    expect(Object.keys(headers).some((h) => h.startsWith("x-forwarded"))).toBe(false);
  });

  it("leaves the socket for the next upgrade listener when the host does not match", async () => {
    proxy.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 599 Fallback Listener\r\n\r\n");
    });
    const statusLine = await readStatusLine("daemon-1.studio.example.com");
    expect(statusLine).toBe("HTTP/1.1 599 Fallback Listener");
  });
});
