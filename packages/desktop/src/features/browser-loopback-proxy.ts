import { getPaseoBrowserWorkspacePartition } from "./browser-profile.js";
import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { session as electronSession, webContents as allWebContents } from "electron";

export interface BrowserLoopbackProxyRegistration {
  browserId: string;
  serverId: string;
  workspaceId: string;
  rendererWebContentsId: number;
  /** Local daemon: 127.0.0.1 is this machine, so skip the workspace TCP tunnel. */
  directLoopback?: boolean;
}

interface WorkspaceProxyRecord {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  rendererWebContentsId: number;
  directLoopback: boolean;
  server: Server | null;
  port: number;
  auth: BrowserProxyAuth;
  browsers: Set<string>;
  activeBrowserId: string;
}

function getWorkspaceKey(input: { workspaceId?: string; browserId: string }): string {
  const trimmed = input.workspaceId?.trim();
  return trimmed && trimmed.length > 0 ? `ws:${trimmed}` : `browser:${input.browserId}`;
}

function sessionPartitionForWorkspaceKey(workspaceKey: string, browserId: string): string {
  if (workspaceKey.startsWith("ws:")) {
    return getPaseoBrowserWorkspacePartition(workspaceKey.slice(3));
  }
  return `persist:paseo-browser-${browserId}`;
}

interface BrowserProxyAuth {
  username: string;
  password: string;
  realm: string;
}

export interface ProxyTarget {
  host: string;
  port: number;
  path: string;
  isConnect: boolean;
}

export interface ParsedProxyRequest {
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

const recordsByWorkspaceKey = new Map<string, WorkspaceProxyRecord>();
const workspaceKeyByBrowserId = new Map<string, string>();
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
  const workspaceKey = workspaceKeyByBrowserId.get(input.browserId) ?? `browser:${input.browserId}`;
  const record = recordsByWorkspaceKey.get(workspaceKey);
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
  const directLoopback = input.directLoopback === true;
  const workspaceKey = getWorkspaceKey(input);
  workspaceKeyByBrowserId.set(input.browserId, workspaceKey);

  const partition = sessionPartitionForWorkspaceKey(workspaceKey, input.browserId);
  const existing = recordsByWorkspaceKey.get(workspaceKey);

  if (directLoopback) {
    if (existing) {
      existing.browsers.add(input.browserId);
      existing.activeBrowserId = input.browserId;
      existing.serverId = input.serverId;
      existing.workspaceId = input.workspaceId;
      existing.rendererWebContentsId = input.rendererWebContentsId;
      existing.directLoopback = true;
    } else {
      recordsByWorkspaceKey.set(workspaceKey, {
        workspaceKey,
        serverId: input.serverId,
        workspaceId: input.workspaceId,
        rendererWebContentsId: input.rendererWebContentsId,
        directLoopback: true,
        server: null,
        port: 0,
        auth: createProxyAuth(),
        browsers: new Set([input.browserId]),
        activeBrowserId: input.browserId,
      });
    }
    // Local daemon: Chromium should use its implicit localhost bypass, not our
    // workspace tunnel proxy. Installing `<-loopback>` here is what made official
    // browser-tabs E2E load a blank guest instead of #typing-target.
    await applyDirectSession(partition);
    return;
  }

  if (existing && existing.port > 0) {
    existing.browsers.add(input.browserId);
    existing.activeBrowserId = input.browserId;
    existing.serverId = input.serverId;
    existing.workspaceId = input.workspaceId;
    existing.rendererWebContentsId = input.rendererWebContentsId;
    existing.directLoopback = false;
    // Re-applying setProxy + closeAllConnections after the guest has attached
    // kills the first navigation. The first register already bound the session.
    return;
  }

  const record = await createWorkspaceProxyRecord(input, workspaceKey);
  if (existing) {
    for (const b of existing.browsers) {
      record.browsers.add(b);
    }
  }
  recordsByWorkspaceKey.set(workspaceKey, record);
  await applyProxyToPartition(partition, record.port);
}

export async function unregisterBrowserLoopbackProxy(browserId: string): Promise<void> {
  const workspaceKey = workspaceKeyByBrowserId.get(browserId) ?? `browser:${browserId}`;
  workspaceKeyByBrowserId.delete(browserId);

  for (const [tunnelId, tunnel] of Array.from(tunnelsById)) {
    if (tunnel.browserId === browserId) {
      closeTunnel(tunnelId, "Browser closed", { notifyRenderer: true });
    }
  }

  const record = recordsByWorkspaceKey.get(workspaceKey);
  if (!record) {
    return;
  }

  record.browsers.delete(browserId);
  if (record.activeBrowserId === browserId) {
    record.activeBrowserId = record.browsers.values().next().value ?? "";
  }

  // Keep workspace proxy alive while other tabs in the workspace are still open.
  if (record.browsers.size > 0) {
    return;
  }

  recordsByWorkspaceKey.delete(workspaceKey);
  if (record.server) {
    await new Promise<void>((resolve) => {
      record.server!.close(() => resolve());
    }).catch(() => undefined);
  }
  const partition = sessionPartitionForWorkspaceKey(workspaceKey, browserId);
  await applyDirectSession(partition);
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

async function createWorkspaceProxyRecord(
  input: BrowserLoopbackProxyRegistration,
  workspaceKey: string,
): Promise<WorkspaceProxyRecord> {
  const server = createServer();
  const record: WorkspaceProxyRecord = {
    workspaceKey,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    rendererWebContentsId: input.rendererWebContentsId,
    directLoopback: input.directLoopback === true,
    auth: createProxyAuth(),
    server,
    port: 0,
    browsers: new Set([input.browserId]),
    activeBrowserId: input.browserId,
  };
  server.on("connection", (socket) => {
    handleProxyConnection(record, socket);
  });
  record.port = await listenOnLoopback(server);
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

async function applyDirectSession(partition: string): Promise<void> {
  if (!electronSession) return;
  await electronSession
    .fromPartition(partition)
    .setProxy({ mode: "direct" })
    .catch(() => undefined);
}

async function applyProxyToPartition(partition: string, port: number): Promise<void> {
  if (!electronSession) return;
  const ses = electronSession.fromPartition(partition);
  await ses.setProxy({
    mode: "fixed_servers",
    proxyRules: `${LOOPBACK_PROXY_HOST}:${port}`,
    proxyBypassRules: browserLoopbackProxyBypassRules(),
  });
  await ses.closeAllConnections().catch(() => undefined);
}

export function browserLoopbackProxyBypassRules(): string {
  return "<-loopback>";
}

export function shouldUseDirectLoopback(input: {
  localDaemonServerId: string;
  tabServerId: string;
}): boolean {
  return input.localDaemonServerId.length > 0 && input.localDaemonServerId === input.tabServerId;
}

function handleProxyConnection(record: WorkspaceProxyRecord, socket: Socket): void {
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
  record: WorkspaceProxyRecord,
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
    if (record.directLoopback) {
      connectDirect(socket, parsed);
      return;
    }
    await connectViaWorkspaceTunnel(record, socket, parsed, tunnelHost);
    return;
  }

  connectDirect(socket, parsed);
}

async function connectViaWorkspaceTunnel(
  record: WorkspaceProxyRecord,
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
  record: WorkspaceProxyRecord,
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
      browserId: record.activeBrowserId || record.browsers.values().next().value || "",
      socket,
      opened: false,
      resolveOpen: resolve,
      rejectOpen: reject,
      timeoutHandle,
    });
    const sent = sendToRenderer(record, "browser-loopback-tunnel-open", {
      tunnelId,
      browserId: record.activeBrowserId || record.browsers.values().next().value || "",
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
  const workspaceKey = tunnel ? workspaceKeyByBrowserId.get(tunnel.browserId) : null;
  const record = workspaceKey ? recordsByWorkspaceKey.get(workspaceKey) : null;
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
  const workspaceKey = workspaceKeyByBrowserId.get(tunnel.browserId);
  const record = workspaceKey ? recordsByWorkspaceKey.get(workspaceKey) : null;
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

function sendToRenderer(
  record: WorkspaceProxyRecord,
  eventName: string,
  payload: unknown,
): boolean {
  const contents = allWebContents.fromId(record.rendererWebContentsId);
  if (!contents || contents.isDestroyed()) {
    return false;
  }
  contents.send(`paseo:event:${eventName}`, payload);
  return true;
}

export function parseBrowserLoopbackProxyRequestForTest(
  buffer: Buffer,
  headerEnd: number,
): ParsedProxyRequest | null {
  return parseProxyRequest(buffer, headerEnd);
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
  const isUpgrade = isUpgradeRequest(headers);
  const upstreamHeaders = rewriteUpstreamHeaders(headers, { forceClose: !isUpgrade });
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

function rewriteUpstreamHeaders(headers: string[], options: { forceClose: boolean }): string[] {
  const result = headers.filter((header) => {
    if (isProxyRequestHeader(header)) {
      return false;
    }
    return !(options.forceClose && header.toLowerCase().startsWith("connection:"));
  });
  if (options.forceClose) {
    result.push("Connection: close");
  }
  return result;
}

function isUpgradeRequest(headers: string[]): boolean {
  const upgradeHeader = findHeader(headers, "upgrade");
  const connectionHeader = findHeader(headers, "connection");
  return Boolean(
    upgradeHeader?.trim() &&
    connectionHeader
      ?.toLowerCase()
      .split(",")
      .some((token) => token.trim() === "upgrade"),
  );
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

export function getBrowserLoopbackProxyPortForTest(browserId: string): number | null {
  const workspaceKey = workspaceKeyByBrowserId.get(browserId) ?? `browser:${browserId}`;
  return recordsByWorkspaceKey.get(workspaceKey)?.port ?? null;
}
