import { createServer, type Server, type Socket } from "node:net";
import {
  getBrowserLoopbackRoute,
  relaySocketThroughHostTunnel,
  type BrowserLoopbackRoute,
} from "./browser-loopback-proxy.js";

/**
 * Forwards a Browser tab's workspace ports to this computer so the dev app opens
 * in the user's own browser. Each forwarded port is a listener on this
 * machine's loopback; every accepted connection rides the same daemon TCP tunnel
 * Browser localhost uses. The local port matches the remote one when it is free,
 * so absolute URLs the app builds (an API on :8080, HMR on :24678) keep working.
 */

const LOCAL_BIND_HOST = "127.0.0.1";

export type PortForwardStatus =
  | { state: "forwarding"; remotePort: number; localPort: number }
  | { state: "port-in-use"; remotePort: number }
  | { state: "failed"; remotePort: number; error: string };

export type StartPortForwardResult =
  | { kind: "local-host" }
  | { kind: "unavailable"; reason: string }
  | { kind: "started"; forwards: PortForwardStatus[] };

interface ActiveForward {
  remotePort: number;
  localPort: number;
  server: Server;
  sockets: Set<Socket>;
}

interface ForwardDeps {
  resolveRoute(browserId: string): BrowserLoopbackRoute | null;
  relay(input: { route: BrowserLoopbackRoute; socket: Socket; port: number }): Promise<void>;
}

const defaultDeps: ForwardDeps = {
  resolveRoute: getBrowserLoopbackRoute,
  relay: relaySocketThroughHostTunnel,
};

export class BrowserPortForwards {
  private readonly byBrowserId = new Map<string, Map<number, ActiveForward>>();
  /**
   * Routes of tabs with no webview here (server browser tabs), given by the renderer when it
   * starts their forwards. A Browser tab's route comes from its loopback proxy registration.
   */
  private readonly givenRoutes = new Map<string, BrowserLoopbackRoute>();

  constructor(private readonly deps: ForwardDeps = defaultDeps) {}

  /**
   * Starts any of `ports` not already forwarded for this tab. A local port that
   * is taken is reported as `port-in-use` unless `fallbackToAnyPort` is set, in
   * which case a free port is picked and returned in `localPort`.
   */
  async start(input: {
    browserId: string;
    ports: readonly number[];
    fallbackToAnyPort?: boolean;
    /** The route of a tab this machine does not render; kept until its forwards stop. */
    route?: BrowserLoopbackRoute;
  }): Promise<StartPortForwardResult> {
    if (input.route) {
      this.givenRoutes.set(input.browserId, input.route);
    }
    const route = this.resolveRoute(input.browserId);
    if (!route) {
      return { kind: "unavailable", reason: "This Browser tab is not connected to a host." };
    }
    if (route.directLoopback) {
      this.forgetGivenRouteIfIdle(input.browserId);
      return { kind: "local-host" };
    }
    const forwards = this.forwardsFor(input.browserId);
    const results: PortForwardStatus[] = [];
    for (const remotePort of normalizePorts(input.ports)) {
      const existing = forwards.get(remotePort);
      if (existing) {
        results.push({ state: "forwarding", remotePort, localPort: existing.localPort });
        continue;
      }
      results.push(
        await this.startOne({
          browserId: input.browserId,
          remotePort,
          fallbackToAnyPort: input.fallbackToAnyPort === true,
        }),
      );
    }
    return { kind: "started", forwards: results };
  }

  list(browserId: string): PortForwardStatus[] {
    return Array.from(this.byBrowserId.get(browserId)?.values() ?? [], (forward) => ({
      state: "forwarding" as const,
      remotePort: forward.remotePort,
      localPort: forward.localPort,
    })).sort((a, b) => a.remotePort - b.remotePort);
  }

  async stop(input: { browserId: string; remotePort: number }): Promise<void> {
    const forwards = this.byBrowserId.get(input.browserId);
    const forward = forwards?.get(input.remotePort);
    if (!forwards || !forward) {
      return;
    }
    forwards.delete(input.remotePort);
    if (forwards.size === 0) {
      this.byBrowserId.delete(input.browserId);
      this.givenRoutes.delete(input.browserId);
    }
    await closeForward(forward);
  }

  async stopAll(browserId: string): Promise<void> {
    this.givenRoutes.delete(browserId);
    const forwards = this.byBrowserId.get(browserId);
    if (!forwards) {
      return;
    }
    this.byBrowserId.delete(browserId);
    await Promise.all(Array.from(forwards.values(), closeForward));
  }

  /** Stops every forward whose route rides this renderer, e.g. when its window closes. */
  async stopAllForRenderer(rendererWebContentsId: number): Promise<void> {
    const browserIds = Array.from(this.givenRoutes)
      .filter(([, route]) => route.rendererWebContentsId === rendererWebContentsId)
      .map(([browserId]) => browserId);
    await Promise.all(browserIds.map((browserId) => this.stopAll(browserId)));
  }

  private resolveRoute(browserId: string): BrowserLoopbackRoute | null {
    return this.deps.resolveRoute(browserId) ?? this.givenRoutes.get(browserId) ?? null;
  }

  private forgetGivenRouteIfIdle(browserId: string): void {
    if (!this.byBrowserId.has(browserId)) {
      this.givenRoutes.delete(browserId);
    }
  }

  private forwardsFor(browserId: string): Map<number, ActiveForward> {
    let forwards = this.byBrowserId.get(browserId);
    if (!forwards) {
      forwards = new Map();
      this.byBrowserId.set(browserId, forwards);
    }
    return forwards;
  }

  private async startOne(input: {
    browserId: string;
    remotePort: number;
    fallbackToAnyPort: boolean;
  }): Promise<PortForwardStatus> {
    const { browserId, remotePort } = input;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // Resolve the route per connection: the tab's host connection can change
      // (reconnect, renderer reload) while the forward stays up.
      const route = this.resolveRoute(browserId);
      if (!route) {
        socket.destroy();
        return;
      }
      this.deps.relay({ route, socket, port: remotePort }).catch(() => {
        socket.destroy();
      });
    });
    let localPort: number;
    try {
      localPort = await listen(server, remotePort);
    } catch (error) {
      if (!isAddressInUse(error)) {
        return { state: "failed", remotePort, error: errorMessage(error) };
      }
      if (!input.fallbackToAnyPort) {
        return { state: "port-in-use", remotePort };
      }
      try {
        localPort = await listen(server, 0);
      } catch (fallbackError) {
        return { state: "failed", remotePort, error: errorMessage(fallbackError) };
      }
    }
    this.forwardsFor(browserId).set(remotePort, { remotePort, localPort, server, sockets });
    return { state: "forwarding", remotePort, localPort };
  }
}

function normalizePorts(ports: readonly number[]): number[] {
  return Array.from(
    new Set(ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)),
  ).sort((a, b) => a - b);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Port forward did not bind a TCP port."));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOCAL_BIND_HOST);
  });
}

async function closeForward(forward: ActiveForward): Promise<void> {
  for (const socket of forward.sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => forward.server.close(() => resolve()));
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
