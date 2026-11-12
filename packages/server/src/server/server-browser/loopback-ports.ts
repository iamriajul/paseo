import type { CdpEvent } from "./cdp-connection.js";

/**
 * The loopback ports a server tab's page talked to (documents, scripts, fetch/XHR, WebSockets),
 * read from CDP Network events. A viewer forwarding the tab to its own machine forwards the whole
 * set, so an app calling an API or HMR socket on a second port keeps working there. The desktop
 * Browser records the same set with `webRequest` (packages/desktop/src/features/browser-loopback-traffic.ts).
 */

const MAX_PORTS_PER_TAB = 32;

export function loopbackPortFromUrl(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!isLoopback) return null;
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80;
}

export class LoopbackPortSet {
  private readonly ports = new Set<number>();

  /** Records the port of a Network event's URL; true for events this set reads. */
  public observe(event: CdpEvent): boolean {
    switch (event.method) {
      case "Network.requestWillBeSent": {
        const request = event.params.request as { url?: unknown } | undefined;
        if (typeof request?.url === "string") this.add(request.url);
        return true;
      }
      case "Network.webSocketCreated":
        if (typeof event.params.url === "string") this.add(event.params.url);
        return true;
      default:
        return event.method.startsWith("Network.");
    }
  }

  public list(): number[] {
    return Array.from(this.ports).sort((a, b) => a - b);
  }

  private add(url: string): void {
    const port = loopbackPortFromUrl(url);
    if (port !== null && this.ports.size < MAX_PORTS_PER_TAB) this.ports.add(port);
  }
}
