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
  /** Electron session partition the proxy is installed on. */
  partition: string;
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
  /** A top-level page load, which gets a readable error page instead of an empty 502. */
  wantsDocument: boolean;
  initialUpstreamBytes: Buffer;
  connectPreambleBytes: Buffer;
  proxyAuthorization: string | null;
}

interface TunnelState {
  tunnelId: string;
  browserId: string;
  rendererWebContentsId: number;
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
// Hosts a renderer has declared to be this machine. The automation handler knows
// the connection and declares it; a pane re-registering the same tab does not,
// and the cached daemon status can be empty or name another daemon. Without
// this memory that second registration flipped the workspace session from
// direct to the tunnel proxy and closeAllConnections() killed the page load.
const directLoopbackServerIds = new Set<string>();

export function resolveBrowserLoopbackProxyCredentials(input: {
  browserId: string | null;
  /**
   * True when the requesting guest's session is this partition's session. The
   * guest's first request can reach the proxy before the renderer's
   * register-attached IPC maps its webContents to a browserId; without this the
   * 407 challenge goes unanswered and the tab renders an empty (black) page.
   */
  guestUsesPartition?: (partition: string) => boolean;
  isProxy: boolean;
  host: string;
  port: number;
}): { username: string; password: string } | null {
  if (!input.isProxy || input.host !== LOOPBACK_PROXY_HOST) {
    return null;
  }
  const record = findProxyRecordForGuest(input);
  if (!record) {
    return null;
  }
  return {
    username: record.auth.username,
    password: record.auth.password,
  };
}

function findProxyRecordForGuest(input: {
  browserId: string | null;
  guestUsesPartition?: (partition: string) => boolean;
  port: number;
}): WorkspaceProxyRecord | null {
  if (input.browserId) {
    const workspaceKey =
      workspaceKeyByBrowserId.get(input.browserId) ?? `browser:${input.browserId}`;
    const record = recordsByWorkspaceKey.get(workspaceKey);
    if (record && record.port === input.port) {
      return record;
    }
  }
  if (!input.guestUsesPartition) {
    return null;
  }
  for (const record of recordsByWorkspaceKey.values()) {
    if (record.port === input.port && input.guestUsesPartition(record.partition)) {
      return record;
    }
  }
  return null;
}

export async function registerBrowserLoopbackProxy(
  input: BrowserLoopbackProxyRegistration,
): Promise<void> {
  if (input.directLoopback === true) {
    directLoopbackServerIds.add(input.serverId);
  }
  const directLoopback = directLoopbackServerIds.has(input.serverId);
  const workspaceKey = getWorkspaceKey(input);
  workspaceKeyByBrowserId.set(input.browserId, workspaceKey);

  const partition = sessionPartitionForWorkspaceKey(workspaceKey, input.browserId);
  const existing = recordsByWorkspaceKey.get(workspaceKey);

  if (directLoopback) {
    const alreadyDirect = existing?.directLoopback === true;
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
        partition,
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
    // Re-applying setProxy after the guest has attached kills the first
    // navigation, same hazard the tunnel path guards below: a remount that
    // re-registers the same workspace (or a second tab in it) lands mid-commit
    // and strands the new guest on about:blank. Skip when already direct.
    if (!alreadyDirect) {
      await applyDirectSession(partition);
    }
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

  const record = await createWorkspaceProxyRecord(input, workspaceKey, partition);
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
  const record = recordsByWorkspaceKey.get(workspaceKey);

  for (const [tunnelId, tunnel] of Array.from(tunnelsById)) {
    if (tunnel.browserId === browserId) {
      closeTunnel(tunnelId, "Browser closed", { notifyRenderer: true });
    }
  }

  workspaceKeyByBrowserId.delete(browserId);
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
  partition: string,
): Promise<WorkspaceProxyRecord> {
  const server = createServer();
  const record: WorkspaceProxyRecord = {
    workspaceKey,
    partition,
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
    await requestRendererTunnel(
      routeForRecord(record),
      tunnelId,
      socket,
      parsed.target.port,
      tunnelHost,
    );
  } catch (error) {
    socket.off("close", closeBrowserTunnel);
    if (!socket.destroyed) {
      socket.end(
        buildProxyFailureResponse({
          parsed,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
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

  upstream.once("error", (error) => {
    if (!connected && !socket.destroyed) {
      socket.end(buildProxyFailureResponse({ parsed, reason: error.message }));
      return;
    }
    socket.destroy();
  });
}

interface RendererTunnelRoute {
  rendererWebContentsId: number;
  browserId: string;
  serverId: string;
  workspaceId: string;
}

function routeForRecord(record: WorkspaceProxyRecord): RendererTunnelRoute {
  return {
    rendererWebContentsId: record.rendererWebContentsId,
    browserId: record.activeBrowserId || record.browsers.values().next().value || "",
    serverId: record.serverId,
    workspaceId: record.workspaceId,
  };
}

function requestRendererTunnel(
  route: RendererTunnelRoute,
  tunnelId: string,
  socket: Socket,
  port: number,
  host: BrowserLoopbackTunnelHost,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      tunnelsById.delete(tunnelId);
      sendToRenderer(route.rendererWebContentsId, "browser-loopback-tunnel-close", {
        tunnelId,
        reason: "Workspace localhost tunnel open timed out.",
      });
      reject(new Error("Workspace localhost tunnel open timed out."));
    }, RENDERER_TUNNEL_OPEN_TIMEOUT_MS);
    tunnelsById.set(tunnelId, {
      tunnelId,
      browserId: route.browserId,
      rendererWebContentsId: route.rendererWebContentsId,
      socket,
      opened: false,
      resolveOpen: resolve,
      rejectOpen: reject,
      timeoutHandle,
    });
    const sent = sendToRenderer(route.rendererWebContentsId, "browser-loopback-tunnel-open", {
      tunnelId,
      browserId: route.browserId,
      serverId: route.serverId,
      workspaceId: route.workspaceId,
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

/** Where a Browser tab's localhost traffic goes: its host and the renderer that owns its tunnels. */
export interface BrowserLoopbackRoute extends RendererTunnelRoute {
  /** The host is this machine; its ports are already reachable here. */
  directLoopback: boolean;
}

export function getBrowserLoopbackRoute(browserId: string): BrowserLoopbackRoute | null {
  const workspaceKey = workspaceKeyByBrowserId.get(browserId);
  const record = workspaceKey ? recordsByWorkspaceKey.get(workspaceKey) : null;
  if (!record) {
    return null;
  }
  return {
    ...routeForRecord(record),
    browserId,
    directLoopback: record.directLoopback,
  };
}

/**
 * Relays an accepted local socket to `port` on the route's host through the
 * renderer's daemon TCP tunnel, the same path Browser localhost uses. Rejects
 * (and leaves the socket to the caller) when the tunnel cannot open.
 */
export async function relaySocketThroughHostTunnel(input: {
  route: RendererTunnelRoute;
  socket: Socket;
  port: number;
}): Promise<void> {
  const tunnelId = randomUUID();
  const { socket } = input;
  socket.pause();
  const closeBrowserTunnel = () => {
    closeTunnel(tunnelId, "Forwarded socket closed", { notifyRenderer: true });
  };
  socket.once("close", closeBrowserTunnel);
  try {
    await requestRendererTunnel(input.route, tunnelId, socket, input.port, "ipv4");
  } catch (error) {
    socket.off("close", closeBrowserTunnel);
    throw error;
  }
  socket.on("data", (chunk: Buffer) => {
    sendTunnelData(tunnelId, chunk);
  });
  socket.once("error", (error) => {
    closeTunnel(tunnelId, error.message, { notifyRenderer: true });
  });
  socket.resume();
}

function sendTunnelData(tunnelId: string, chunk: Buffer): void {
  const tunnel = tunnelsById.get(tunnelId);
  if (!tunnel) {
    return;
  }
  sendToRenderer(tunnel.rendererWebContentsId, "browser-loopback-tunnel-data", {
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
  if (options.notifyRenderer) {
    sendToRenderer(tunnel.rendererWebContentsId, "browser-loopback-tunnel-close", {
      tunnelId,
      reason,
    });
  }
  if (!tunnel.opened) {
    tunnel.rejectOpen(new Error(reason));
  }
  if (!tunnel.socket.destroyed) {
    tunnel.socket.destroy();
  }
}

function sendToRenderer(
  rendererWebContentsId: number,
  eventName: string,
  payload: unknown,
): boolean {
  const contents = allWebContents.fromId(rendererWebContentsId);
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
      wantsDocument: false,
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
    wantsDocument: !isUpgrade && isDocumentRequest(headers),
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

function isDocumentRequest(headers: string[]): boolean {
  const dest = findHeader(headers, "sec-fetch-dest");
  if (dest) {
    return dest.toLowerCase() === "document";
  }
  return findHeader(headers, "accept")?.toLowerCase().includes("text/html") === true;
}

const ERROR_PAGE_RETRY_LIMIT_SECONDS = 30;
/**
 * A successful load never runs the error page, so the attempt count can't be reset there. A count
 * older than this belongs to an earlier outage, and a new one starts again at the short backoff.
 */
const ERROR_PAGE_RETRY_STALE_MS = 2 * 60 * 1000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Electron renders nothing for an empty 502, so a failed localhost load used
 * to leave the tab black with no hint. Page loads get a readable page that
 * says what failed and retries with backoff, so a tab opened before the dev
 * server or host connection is ready recovers by itself.
 */
export function buildProxyFailureResponse(input: {
  parsed: Pick<ParsedProxyRequest, "target" | "wantsDocument">;
  reason: string;
}): string {
  const head = ["HTTP/1.1 502 Bad Gateway", "Cache-Control: no-store", "Connection: close"];
  if (!input.parsed.wantsDocument) {
    return [...head, "Content-Length: 0", "", ""].join("\r\n");
  }
  const target = `${input.parsed.target.host}:${input.parsed.target.port}`;
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Can't reach ${escapeHtml(target)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:520px;padding:24px}
h1{font-size:18px;margin:0 0 8px}
p{margin:0 0 12px;opacity:.8}
code{font:12px ui-monospace,monospace;word-break:break-word}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}
</style></head><body><main data-paseo-browser-error="proxy">
<h1>Can't reach ${escapeHtml(target)}</h1>
<p>Paseo could not connect to this port on the workspace host. Check that the dev server is running.</p>
<p><code>${escapeHtml(input.reason)}</code></p>
<p><button id="retry" type="button">Retry now</button> <span id="status"></span></p>
</main><script>
(function(){
  var key = "paseo-browser-retry:" + location.href;
  var saved = (sessionStorage.getItem(key) || "").split("|");
  var outageContinues = Date.now() - Number(saved[1] || 0) < ${ERROR_PAGE_RETRY_STALE_MS};
  var attempt = (outageContinues ? Number(saved[0] || 0) : 0) + 1;
  sessionStorage.setItem(key, attempt + "|" + Date.now());
  var wait = Math.min(${ERROR_PAGE_RETRY_LIMIT_SECONDS}, Math.pow(2, Math.min(attempt, 5)));
  var status = document.getElementById("status");
  function reload(){ location.reload(); }
  document.getElementById("retry").addEventListener("click", reload);
  var left = wait;
  function tick(){
    status.textContent = "Retrying in " + left + "s";
    if (left <= 0) { reload(); return; }
    left -= 1; setTimeout(tick, 1000);
  }
  tick();
})();
</script></body></html>`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  return [
    ...head,
    "Content-Type: text/html; charset=utf-8",
    `Content-Length: ${bodyBytes}`,
    "",
    body,
  ].join("\r\n");
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
