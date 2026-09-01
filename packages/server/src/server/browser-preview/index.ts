import http, { type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { stripHopByHopHeaders } from "../service-proxy.js";
import { transformPreviewResponseHeaders } from "./response-headers.js";
import type { BrowserPreviewTemplate } from "./url-template.js";

// Dial "localhost" rather than a literal address. Node's autoSelectFamily
// (default true on Node >= 20) tries both loopback families, so a dev server
// bound only to ::1 still resolves — without a manual retry, which would have
// to pipe the request a second time and would forward an empty body for any
// request whose body the first pipe already consumed.
const UPSTREAM_HOST = "localhost";

export interface BrowserPreviewSubsystem {
  middleware(): RequestHandler;
  // Returns whether this upgrade matched a preview host and was claimed.
  // The caller needs this synchronously — before openUpstream's dial
  // settles — to know whether it may still hand the socket to another
  // candidate listener or must leave it alone.
  upgradeHandler(): (req: IncomingMessage, socket: Socket, head: Buffer) => boolean;
}

// The dev server must see the request as if it arrived on loopback directly:
// Host forged, Origin dropped, no X-Forwarded-* at all.
function buildUpstreamHeaders({
  req,
  port,
}: {
  req: IncomingMessage;
  port: number;
}): NodeJS.Dict<string | string[]> {
  const headers: NodeJS.Dict<string | string[]> = stripHopByHopHeaders(req.headers);
  delete headers.origin;
  headers.host = `localhost:${port}`;
  return headers;
}

function openUpstream({
  req,
  port,
  headers,
}: {
  req: IncomingMessage;
  port: number;
  headers: NodeJS.Dict<string | string[]>;
}): http.ClientRequest {
  return http.request({
    host: UPSTREAM_HOST,
    port,
    method: req.method,
    path: req.url,
    headers,
    // The default global agent can leave the underlying socket lingering
    // past destroy() — observed as the peer never seeing the connection
    // close. agent: false ties the socket directly to this one request.
    agent: false,
  });
}

export function createBrowserPreviewSubsystem(options: {
  template: BrowserPreviewTemplate | null;
  logger: Logger;
}): BrowserPreviewSubsystem {
  const { template } = options;
  const logger = options.logger.child({ module: "browser-preview" });

  return {
    middleware(): RequestHandler {
      return (req, res, next) => {
        const port = template?.matchHost(req.headers.host) ?? null;
        if (port === null || !template) {
          next();
          return;
        }

        const upstream = openUpstream({ req, port, headers: buildUpstreamHeaders({ req, port }) });
        upstream.on("response", (upstreamRes) => {
          const headers = transformPreviewResponseHeaders({
            headers: stripHopByHopHeaders(upstreamRes.headers),
            targetPort: port,
            template,
          });
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.pipe(res);
        });
        upstream.on("error", (error: NodeJS.ErrnoException) => {
          logger.debug({ err: error, port }, "browser_preview_upstream_failed");
          if (!res.headersSent) res.status(502).send("502 Bad Gateway");
          else res.end();
        });
        req.pipe(upstream);
      };
    },

    upgradeHandler() {
      return (req: IncomingMessage, socket: Socket, head: Buffer): boolean => {
        const port = template?.matchHost(req.headers.host) ?? null;
        if (port === null || !template) return false; // leave the socket for the next listener

        // buildUpstreamHeaders strips connection/upgrade as hop-by-hop; put
        // them back or the dev server sees a plain GET and never fires its
        // own 'upgrade' event.
        const headers = buildUpstreamHeaders({ req, port });
        headers.connection = "Upgrade";
        headers.upgrade = req.headers.upgrade ?? "websocket";
        const upstream = openUpstream({ req, port, headers });

        // Covers every way the pending dial can reach a terminal state:
        // upgraded (101), declined (an ordinary response), or failed
        // outright (upstream 'error'). Sets before its own cleanup runs so
        // abandon() — triggered independently by the client disconnecting —
        // never redundantly re-destroys an already-settled dial.
        let settled = false;
        // http.Server sockets are allowHalfOpen: true (required for
        // upgrades to work at all), so a client disconnecting while the
        // dial is still pending surfaces as 'end' here, not 'close' — and
        // nothing else about this socket is ever read or written, so
        // nothing else would notice or abort the in-flight upstream request.
        const abandon = () => {
          if (!settled) {
            upstream.destroy();
            socket.destroy();
          }
        };
        socket.on("end", abandon);
        socket.on("close", abandon);

        upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
          settled = true;
          const lines = Object.entries(upstreamRes.headers).flatMap(([k, v]) => {
            if (Array.isArray(v)) return v.map((item) => `${k}: ${item}`);
            return v ? [`${k}: ${v}`] : [];
          });
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
          if (upstreamHead.length) socket.write(upstreamHead);
          upstreamSocket.pipe(socket);
          socket.pipe(upstreamSocket);
          // allowHalfOpen again: a peer's FIN only ever produces 'end' here,
          // and pipe()'s default end-forwarding only half-closes the other
          // leg in response. Without explicitly destroying both sides on
          // either signal, neither leg ever finishes closing on its own,
          // and both servers' close() would hang waiting for a socket that
          // never gets there.
          const teardown = () => {
            socket.destroy();
            upstreamSocket.destroy();
          };
          upstreamSocket.on("end", teardown);
          socket.on("end", teardown);
          upstreamSocket.on("close", teardown);
          socket.on("close", teardown);
          upstreamSocket.on("error", (error) => {
            logger.debug({ err: error, port }, "browser_preview_upgrade_upstream_socket_failed");
          });
          socket.on("error", (error) => {
            logger.debug({ err: error, port }, "browser_preview_upgrade_client_socket_failed");
          });
        });
        // The dev server declined the upgrade — wrong path, misconfigured,
        // mid-restart — and answered with an ordinary response instead of
        // 101. There's no clean way to hand that back over a socket the
        // client is waiting to speak WS on, so drain it and close: a
        // definite failure signal beats leaving the handshake hanging with
        // none at all.
        upstream.on("response", (upstreamRes) => {
          settled = true;
          upstreamRes.resume();
          socket.destroy();
        });
        upstream.on("error", (error) => {
          settled = true;
          logger.debug({ err: error, port }, "browser_preview_upgrade_failed");
          socket.destroy();
        });
        if (head.length) upstream.write(head);
        upstream.end();
        return true;
      };
    },
  };
}
