import { isStandardLoopbackHostname } from "@/utils/localhost-url";

/**
 * Which loopback ports Android Browser pages talk to, so "Open on this phone" forwards the
 * whole set an app needs (its API, its HMR socket) and not only the address bar's port.
 *
 * The WebView proxy override is process-wide: a proxied connection names no tab, only the host
 * route it rides. So each request is filed under the page that made it, read from its `Origin`
 * or `Referer` header, and a tab's set is every port reachable from its address-bar port. The
 * proxy closes each HTTP request's connection (`Connection: close`), so every request and every
 * WebSocket arrives here as its own connection with its headers.
 */

const MAX_PORTS = 32;

/** serverId → page port → ports that page's requests went to. */
const portsByHost = new Map<string, Map<number, Set<number>>>();

function loopbackPortOf(value: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return null;
  if (!isStandardLoopbackHostname(parsed.hostname)) return null;
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80;
}

/** The loopback port of the page that sent this request, from its header block. */
export function pagePortOfRequest(requestHead: string): number | null {
  let origin: string | null = null;
  let referer: string | null = null;
  for (const line of requestHead.split("\r\n").slice(1)) {
    if (line === "") break;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "origin") origin = value;
    else if (name === "referer") referer = value;
  }
  // An opaque origin sends "null"; the Referer may still name the page.
  const fromOrigin = origin && origin !== "null" ? loopbackPortOf(origin) : null;
  return fromOrigin ?? (referer ? loopbackPortOf(referer) : null);
}

export function recordMobileBrowserLoopbackRequest(input: {
  serverId: string;
  port: number;
  requestHead: string;
}): void {
  const pagePort = pagePortOfRequest(input.requestHead);
  if (pagePort === null || pagePort === input.port) return;
  let pages = portsByHost.get(input.serverId);
  if (!pages) {
    pages = new Map();
    portsByHost.set(input.serverId, pages);
  }
  let ports = pages.get(pagePort);
  if (!ports) {
    ports = new Set();
    pages.set(pagePort, ports);
  }
  if (ports.size < MAX_PORTS) ports.add(input.port);
}

/**
 * The ports a page on `pagePort` used, and the ports its frames on those ports used in turn
 * (an iframe on :3000 calling :8080). Excludes `pagePort` itself.
 */
export function listMobileBrowserLoopbackPorts(serverId: string, pagePort: number): number[] {
  const pages = portsByHost.get(serverId);
  if (!pages) return [];
  const seen = new Set<number>([pagePort]);
  const queue = [pagePort];
  for (let index = 0; index < queue.length && seen.size <= MAX_PORTS; index += 1) {
    for (const port of pages.get(queue[index]) ?? []) {
      if (seen.has(port)) continue;
      seen.add(port);
      queue.push(port);
    }
  }
  seen.delete(pagePort);
  return Array.from(seen)
    .sort((a, b) => a - b)
    .slice(0, MAX_PORTS);
}
