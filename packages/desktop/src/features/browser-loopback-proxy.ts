import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { session as electronSession, webContents as allWebContents } from "electron";

export interface BrowserLoopbackProxyRegistration {
  browserId: string;
  serverId: string;
  workspaceId: string;
  rendererWebContentsId: number;
}

interface BrowserProxyRecord extends BrowserLoopbackProxyRegistration {
  server: Server;
  port: number;
  auth: BrowserProxyAuth;
}

interface BrowserProxyAuth {
  username: string;
  password: string;
  realm: string;
}

interface ProxyTarget {
  host: string;
  port: number;
  path: string;
  isConnect: boolean;
}

interface ParsedProxyRequest {
  target: ProxyTarget;
  initialUpstreamBytes: Buffer;
  connectPreambleBytes: Buffer;
  proxyAuthorization: string | null;
}

interface TunnelState {
  tunnelId: string;
  browserId: string;
  socket: Socket;
  opened: boolean;
  resolveOpen: () => void;
  rejectOpen: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

type BrowserLoopbackTunnelHost = "ipv4" | "ipv6";

const LOOPBACK_PROXY_HOST = "127.0.0.1";
const HEADER_LIMIT_BYTES = 64 * 1024;
const INITIAL_HEADER_TIMEOUT_MS = 15_000;
const RENDERER_TUNNEL_OPEN_TIMEOUT_MS = 15_000;

const recordsByBrowserId = new Map<string, BrowserProxyRecord>();
const tunnelsById = new Map<string, TunnelState>();

export function resolveBrowserLoopbackProxyCredentials(input: {
  browserId: string;
  isProxy: boolean;
  host: string;
  port: number;
}): { username: string; password: string } | null {
  if (!input.isProxy || input.host !== LOOPBACK_PROXY_HOST) {
    return null;
  }
  const record = recordsByBrowserId.get(input.browserId);
  if (!record || record.port !== input.port) {
    return null;
  }
  return {
    username: record.auth.username,
    password: record.auth.password,
  };
}

export async function registerBrowserLoopbackProxy(
  input: BrowserLoopbackProxyRegistration,
): Promise<void> {
  const existing = recordsByBrowserId.get(input.browserId);
  if (existing) {
    existing.serverId = input.serverId;
    existing.workspaceId = input.workspaceId;
    existing.rendererWebContentsId = input.rendererWebContentsId;
    await applyProxyToBrowserSession(input.browserId, existing.port);
    return;
  }

  const record = await createBrowserProxyRecord(input);
  recordsByBrowserId.set(input.browserId, record);
  await applyProxyToBrowserSession(input.browserId, record.port);
}

export async function unregisterBrowserLoopbackProxy(browserId: string): Promise<void> {
  const record = recordsByBrowserId.get(browserId);
  for (const [tunnelId, tunnel] of Array.from(tunnelsById)) {
    if (tunnel.browserId === browserId) {
      closeTunnel(tunnelId, "Browser closed", { notifyRenderer: true });
    }
  }
  recordsByBrowserId.delete(browserId);
  if (record) {
    await new Promise<void>((resolve) => {
      record.server.close(() => resolve());
    }).catch(() => undefined);
  }
  await electronSession
    .fromPartition(browserPartition(browserId))
    .setProxy({ mode: "direct" })
    .catch(() => undefined);
}

export function handleLoopbackTunnelOpenResult(payload: unknown): void {
  const parsed = readTunnelOpenResult(payload);
  if (!parsed) {
    return;
  }
  const tunnel = tunnelsById.get(parsed.tunnelId);
  if (!tunnel) {
    return;
  }
  clearTimeout(tunnel.timeoutHandle);
  if (!parsed.ok) {
    const reason = parsed.reason || "Workspace localhost tunnel failed to open.";
    tunnelsById.delete(parsed.tunnelId);
    tunnel.rejectOpen(new Error(reason));
    return;
  }
  tunnel.opened = true;
  tunnel.resolveOpen();
}

export function handleLoopbackTunnelData(payload: unknown): void {
  const parsed = readTunnelData(payload);
  if (!parsed) {
    return;
  }
  const tunnel = tunnelsById.get(parsed.tunnelId);
  if (!tunnel || tunnel.socket.destroyed) {
    return;
  }
  tunnel.socket.write(Buffer.from(parsed.binaryBase64, "base64"));
}

export function handleLoopbackTunnelClose(payload: unknown): void {
  const parsed = readTunnelClose(payload);
  if (!parsed) {
    return;
  }
  closeTunnel(parsed.tunnelId, parsed.reason || "Workspace localhost tunnel closed", {
    notifyRenderer: false,
  });
}

async function createBrowserProxyRecord(
  input: BrowserLoopbackProxyRegistration,
): Promise<BrowserProxyRecord> {
  const record: BrowserProxyRecord = {
    ...input,
    auth: createProxyAuth(),
    server: createServer(),
    port: 0,
  };
  record.server.on("connection", (socket) => {
    handleProxyConnection(record, socket);
  });
  record.port = await listenOnLoopback(record.server);
  return record;
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Browser loopback proxy failed to bind to a TCP port."));
        return;
      }
      resolve(address.port);
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK_PROXY_HOST);
  });
}

async function applyProxyToBrowserSession(browserId: string, port: number): Promise<void> {
  const ses = electronSession.fromPartition(browserPartition(browserId));
  await ses.setProxy({
    mode: "fixed_servers",
    proxyRules: `${LOOPBACK_PROXY_HOST}:${port}`,
    proxyBypassRules: "<-loopback>",
  });
  await ses.closeAllConnections().catch(() => undefined);
}

function browserPartition(browserId: string): string {
  return `persist:paseo-browser-${browserId}`;
}

function handleProxyConnection(record: BrowserProxyRecord, socket: Socket): void {
  let chunks: Buffer[] = [];
  let totalBytes = 0;
  const timeoutHandle = setTimeout(() => {
    socket.destroy();
  }, INITIAL_HEADER_TIMEOUT_MS);

  socket.on("error", () => {
    socket.destroy();
  });

  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
    if (totalBytes > HEADER_LIMIT_BYTES) {
      cleanup();
      socket.end("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
      return;
    }
    const combined = Buffer.concat(chunks, totalBytes);
    const headerEnd = combined.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    cleanup();
    socket.pause();
    void handleParsedProxyRequest(record, socket, combined, headerEnd + 4).catch(() => {
      socket.destroy();
    });
  };

  const cleanup = () => {
    clearTimeout(timeoutHandle);
    socket.off("data", onData);
    chunks = [];
    totalBytes = 0;
  };

  socket.on("data", onData);
}

async function handleParsedProxyRequest(
  record: BrowserProxyRecord,
  socket: Socket,
  buffer: Buffer,
  headerEnd: number,
): Promise<void> {
  const parsed = parseProxyRequest(buffer, headerEnd);
  if (!parsed) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  if (!isProxyAuthorized(parsed.proxyAuthorization, record.auth)) {
    sendProxyAuthenticationRequired(socket, record.auth);
    return;
  }

  const tunnelHost = getLoopbackTunnelHost(parsed.target.host);
  if (tunnelHost) {
    await connectViaWorkspaceTunnel(record, socket, parsed, tunnelHost);
    return;
  }

  connectDirect(socket, parsed);
}

async function connectViaWorkspaceTunnel(
  record: BrowserProxyRecord,
  socket: Socket,
  parsed: ParsedProxyRequest,
  tunnelHost: BrowserLoopbackTunnelHost,
): Promise<void> {
  const tunnelId = randomUUID();
  const closeBrowserTunnel = () => {
    closeTunnel(tunnelId, "Browser socket closed", { notifyRenderer: true });
  };
  socket.once("close", closeBrowserTunnel);
  try {
    await requestRendererTunnel(record, tunnelId, socket, parsed.target.port, tunnelHost);
  } catch {
    socket.off("close", closeBrowserTunnel);
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    return;
  }
  if (socket.destroyed) {
    closeTunnel(tunnelId, "Browser socket closed", { notifyRenderer: true });
    return;
  }

  if (parsed.target.isConnect) {
    socket.write(parsed.connectPreambleBytes);
    if (parsed.initialUpstreamBytes.byteLength > 0) {
      sendTunnelData(tunnelId, parsed.initialUpstreamBytes);
    }
  } else if (parsed.initialUpstreamBytes.byteLength > 0) {
    sendTunnelData(tunnelId, parsed.initialUpstreamBytes);
  }

  socket.on("data", (chunk: Buffer) => {
    sendTunnelData(tunnelId, chunk);
  });
  socket.once("error", (error) => {
    closeTunnel(tunnelId, error.message, { notifyRenderer: true });
  });
  socket.resume();
}

function connectDirect(socket: Socket, parsed: ParsedProxyRequest): void {
  const upstream = createConnection({ host: parsed.target.host, port: parsed.target.port });
  let connected = false;
  const destroyUpstream = () => {
    upstream.destroy();
  };
  socket.once("close", destroyUpstream);
  upstream.once("close", () => {
    socket.off("close", destroyUpstream);
  });

  upstream.once("connect", () => {
    connected = true;
    if (parsed.target.isConnect) {
      socket.write(parsed.connectPreambleBytes);
      if (parsed.initialUpstreamBytes.byteLength > 0) {
        upstream.write(parsed.initialUpstreamBytes);
      }
    } else if (parsed.initialUpstreamBytes.byteLength > 0) {
      upstream.write(parsed.initialUpstreamBytes);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.resume();
  });

  upstream.once("error", () => {
    if (!connected && !socket.destroyed) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    socket.destroy();
  });
}

function requestRendererTunnel(
  record: BrowserProxyRecord,
  tunnelId: string,
  socket: Socket,
  port: number,
  host: BrowserLoopbackTunnelHost,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      tunnelsById.delete(tunnelId);
      sendToRenderer(record, "browser-loopback-tunnel-close", {
        tunnelId,
        reason: "Workspace localhost tunnel open timed out.",
      });
      reject(new Error("Workspace localhost tunnel open timed out."));
    }, RENDERER_TUNNEL_OPEN_TIMEOUT_MS);
    tunnelsById.set(tunnelId, {
      tunnelId,
      browserId: record.browserId,
      socket,
      opened: false,
      resolveOpen: resolve,
      rejectOpen: reject,
      timeoutHandle,
    });
    const sent = sendToRenderer(record, "browser-loopback-tunnel-open", {
      tunnelId,
      browserId: record.browserId,
      serverId: record.serverId,
      workspaceId: record.workspaceId,
      port,
      host,
    });
    if (!sent) {
      clearTimeout(timeoutHandle);
      tunnelsById.delete(tunnelId);
      reject(new Error("Browser renderer is unavailable."));
    }
  });
}

function sendTunnelData(tunnelId: string, chunk: Buffer): void {
  const tunnel = tunnelsById.get(tunnelId);
  const record = tunnel ? recordsByBrowserId.get(tunnel.browserId) : null;
  if (!tunnel || !record) {
    return;
  }
  sendToRenderer(record, "browser-loopback-tunnel-data", {
    tunnelId,
    binaryBase64: chunk.toString("base64"),
  });
}

function closeTunnel(tunnelId: string, reason: string, options: { notifyRenderer: boolean }): void {
  const tunnel = tunnelsById.get(tunnelId);
  if (!tunnel) {
    return;
  }
  tunnelsById.delete(tunnelId);
  clearTimeout(tunnel.timeoutHandle);
  const record = recordsByBrowserId.get(tunnel.browserId);
  if (options.notifyRenderer && record) {
    sendToRenderer(record, "browser-loopback-tunnel-close", { tunnelId, reason });
  }
  if (!tunnel.opened) {
    tunnel.rejectOpen(new Error(reason));
  }
  if (!tunnel.socket.destroyed) {
    tunnel.socket.destroy();
  }
}

function sendToRenderer(record: BrowserProxyRecord, eventName: string, payload: unknown): boolean {
  const contents = allWebContents.fromId(record.rendererWebContentsId);
  if (!contents || contents.isDestroyed()) {
    return false;
  }
  contents.send(`paseo:event:${eventName}`, payload);
  return true;
}

function parseProxyRequest(buffer: Buffer, headerEnd: number): ParsedProxyRequest | null {
  const headerText = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = headerText.split("\r\n");
  const requestLine = lines[0] ?? "";
  const [method, rawTarget, version] = requestLine.split(" ");
  if (!method || !rawTarget || !version?.startsWith("HTTP/")) {
    return null;
  }

  const headers = lines.slice(1, -2);
  const hostHeader = findHeader(headers, "host");
  const proxyAuthorization = findHeader(headers, "proxy-authorization");
  const upstreamHeaders = headers.filter((header) => !isProxyRequestHeader(header));
  const remainder = buffer.subarray(headerEnd);

  if (method.toUpperCase() === "CONNECT") {
    const authority = parseAuthority(rawTarget, 443);
    if (!authority) {
      return null;
    }
    return {
      target: { host: authority.host, port: authority.port, path: "", isConnect: true },
      initialUpstreamBytes: remainder,
      connectPreambleBytes: Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"),
      proxyAuthorization,
    };
  }

  const target = parseHttpTarget(rawTarget, hostHeader);
  if (!target) {
    return null;
  }
  const rewrittenHead = Buffer.from(
    [`${method} ${target.path} ${version}`, ...upstreamHeaders, "", ""].join("\r\n"),
    "latin1",
  );
  return {
    target: { ...target, isConnect: false },
    initialUpstreamBytes:
      remainder.byteLength > 0 ? Buffer.concat([rewrittenHead, remainder]) : rewrittenHead,
    connectPreambleBytes: Buffer.alloc(0),
    proxyAuthorization,
  };
}

function parseHttpTarget(
  rawTarget: string,
  hostHeader: string | null,
): { host: string; port: number; path: string } | null {
  if (/^(https?|wss?):\/\//i.test(rawTarget)) {
    try {
      const parsed = new URL(rawTarget);
      const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
      const defaultPort = isSecure ? 443 : 80;
      return {
        host: parsed.hostname,
        port: parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort,
        path: `${parsed.pathname || "/"}${parsed.search}`,
      };
    } catch {
      return null;
    }
  }
  const authority = hostHeader ? parseAuthority(hostHeader, 80) : null;
  if (!authority) {
    return null;
  }
  return {
    host: authority.host,
    port: authority.port,
    path: rawTarget.startsWith("/") ? rawTarget : `/${rawTarget}`,
  };
}

function parseAuthority(
  authority: string,
  defaultPort: number,
): { host: string; port: number } | null {
  try {
    const parsed = new URL(`http://${authority}`);
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

function findHeader(headers: string[], name: string): string | null {
  const prefix = `${name.toLowerCase()}:`;
  for (const header of headers) {
    if (header.toLowerCase().startsWith(prefix)) {
      return header.slice(prefix.length).trim();
    }
  }
  return null;
}

function getLoopbackTunnelHost(host: string): BrowserLoopbackTunnelHost | null {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalized === "::" || normalized === "::1") {
    return "ipv6";
  }
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  ) {
    return "ipv4";
  }
  return null;
}

function createProxyAuth(): BrowserProxyAuth {
  return {
    username: "paseo",
    password: `${randomUUID()}${randomUUID()}`,
    realm: `paseo-browser-${randomUUID()}`,
  };
}

function isProxyAuthorized(value: string | null, auth: BrowserProxyAuth): boolean {
  const prefix = "basic ";
  if (!value?.toLowerCase().startsWith(prefix)) {
    return false;
  }
  const encoded = value.slice(prefix.length).trim();
  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }
  return decoded === `${auth.username}:${auth.password}`;
}

function sendProxyAuthenticationRequired(socket: Socket, auth: BrowserProxyAuth): void {
  socket.end(
    [
      "HTTP/1.1 407 Proxy Authentication Required",
      `Proxy-Authenticate: Basic realm="${auth.realm}"`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
  );
}

function isProxyRequestHeader(header: string): boolean {
  const lower = header.toLowerCase();
  return lower.startsWith("proxy-authorization:") || lower.startsWith("proxy-connection:");
}

function readTunnelOpenResult(
  payload: unknown,
): { tunnelId: string; ok: boolean; reason: string | null } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.tunnelId !== "string" || record.tunnelId.trim().length === 0) {
    return null;
  }
  if (typeof record.ok !== "boolean") {
    return null;
  }
  return {
    tunnelId: record.tunnelId.trim(),
    ok: record.ok,
    reason: typeof record.reason === "string" ? record.reason : null,
  };
}

function readTunnelData(payload: unknown): { tunnelId: string; binaryBase64: string } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.tunnelId !== "string" || record.tunnelId.trim().length === 0) {
    return null;
  }
  if (typeof record.binaryBase64 !== "string") {
    return null;
  }
  return { tunnelId: record.tunnelId.trim(), binaryBase64: record.binaryBase64 };
}

function readTunnelClose(payload: unknown): { tunnelId: string; reason: string | null } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.tunnelId !== "string" || record.tunnelId.trim().length === 0) {
    return null;
  }
  return {
    tunnelId: record.tunnelId.trim(),
    reason: typeof record.reason === "string" ? record.reason : null,
  };
}
