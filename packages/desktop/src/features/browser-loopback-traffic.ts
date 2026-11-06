/**
 * Records which loopback ports each Browser tab's page talks to (documents,
 * scripts, fetch/XHR, WebSockets), so "open on this computer" can forward the
 * whole set an app needs instead of only the port in the address bar.
 */

interface WebRequestSession {
  webRequest: {
    onSendHeaders(
      filter: { urls: string[] },
      listener: (details: { url: string; webContentsId?: number }) => void,
    ): void;
  };
}

const MAX_PORTS_PER_BROWSER = 32;
const observedSessions = new WeakSet<object>();
const portsByBrowserId = new Map<string, Set<number>>();

export function loopbackPortFromUrl(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!isLoopback) {
    return null;
  }
  if (parsed.port) {
    return Number(parsed.port);
  }
  return parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80;
}

export function recordBrowserLoopbackRequest(input: { browserId: string; url: string }): void {
  const port = loopbackPortFromUrl(input.url);
  if (port === null) {
    return;
  }
  let ports = portsByBrowserId.get(input.browserId);
  if (!ports) {
    ports = new Set();
    portsByBrowserId.set(input.browserId, ports);
  }
  if (ports.size < MAX_PORTS_PER_BROWSER) {
    ports.add(port);
  }
}

/** Installs the observer once per Browser session partition. */
export function observeBrowserLoopbackTraffic(input: {
  session: WebRequestSession;
  resolveBrowserId: (webContentsId: number) => string | null;
}): void {
  if (observedSessions.has(input.session)) {
    return;
  }
  observedSessions.add(input.session);
  input.session.webRequest.onSendHeaders({ urls: ["<all_urls>"] }, (details) => {
    if (typeof details.webContentsId !== "number") {
      return;
    }
    const browserId = input.resolveBrowserId(details.webContentsId);
    if (browserId) {
      recordBrowserLoopbackRequest({ browserId, url: details.url });
    }
  });
}

export function listObservedLoopbackPorts(browserId: string): number[] {
  return Array.from(portsByBrowserId.get(browserId) ?? []).sort((a, b) => a - b);
}

export function forgetObservedLoopbackPorts(browserId: string): void {
  portsByBrowserId.delete(browserId);
}
