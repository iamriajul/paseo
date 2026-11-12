import type {
  PortForwardController,
  PortForwardList,
  PortForwardRoute,
  PortForwardStartResult,
  PortForwardStatus,
} from "./types";

/** The native listeners (PortForwardListeners.kt): one ServerSocket per forward on 127.0.0.1. */
export interface NativePortForwards {
  startPortForward(
    forwardId: string,
    port: number,
    fallbackToAnyPort: boolean,
  ): Promise<
    | { state: "forwarding"; localPort: number }
    | { state: "port-in-use" }
    | { state: "failed"; error: string }
  >;
  stopPortForward(forwardId: string): void;
  acceptForwardConnection(connectionId: string): void;
  writeForwardConnection(connectionId: string, binaryBase64: string): void;
  closeForwardConnection(connectionId: string, reason?: string): void;
}

export interface ForwardConnectionOpenEvent {
  forwardId: string;
  connectionId: string;
}
export interface ForwardConnectionDataEvent {
  connectionId: string;
  binaryBase64: string;
}
export interface ForwardConnectionCloseEvent {
  connectionId: string;
  reason?: string | null;
}

/** A daemon TCP tunnel stream (DaemonClient.openTcpTunnel). */
export interface ForwardTunnel {
  write(data: Uint8Array): void;
  close(reason?: string): void;
  onData(handler: (data: Uint8Array) => void): () => void;
  onClose(handler: (reason: string) => void): () => void;
}

export interface MobilePortForwardDeps {
  native: NativePortForwards;
  /** Opens a tunnel to `port` on the host's loopback; rejects with a message the user can act on. */
  openTunnel(input: { serverId: string; port: number }): Promise<ForwardTunnel>;
  /**
   * The foreground service and its notification, held while any forward is open, so Android
   * keeps Paseo and its WebSocket running behind the user's browser.
   */
  service: { show(): Promise<void>; hide(): void };
  /** True when the host is this phone: nothing to forward. Never on a phone today. */
  isLocalHost?(serverId: string): boolean;
  encodeBase64(data: Uint8Array): string;
  decodeBase64(base64: string): Uint8Array;
}

interface ActiveForward {
  forwardId: string;
  browserId: string;
  route: PortForwardRoute;
  remotePort: number;
  localPort: number;
}

interface ActiveConnection {
  forwardId: string;
  tunnel: ForwardTunnel | null;
  dispose: () => void;
  closed: boolean;
}

/**
 * "Open on this phone" (Android): binds each of a tab's host ports on the phone's 127.0.0.1 and
 * relays every connection through the daemon TCP tunnel Browser localhost already uses. The
 * foreground service runs exactly while at least one forward is open.
 */
export class MobilePortForwards implements PortForwardController {
  public readonly device = "phone" as const;
  private readonly forwards = new Map<string, ActiveForward>();
  private readonly connections = new Map<string, ActiveConnection>();
  /** Non-forwarding results of the last start, so the menu can say why a port is missing. */
  private readonly lastProblems = new Map<string, Map<number, PortForwardStatus>>();
  private nextForwardId = 1;
  private serviceShown = false;
  private serviceChange: Promise<void> = Promise.resolve();
  private readonly idleWaiters = new Set<() => void>();

  public constructor(private readonly deps: MobilePortForwardDeps) {}

  public async start(input: {
    browserId: string;
    ports: readonly number[];
    fallbackToAnyPort: boolean;
    route?: PortForwardRoute;
  }): Promise<PortForwardStartResult> {
    const route = input.route ?? this.routeOf(input.browserId);
    if (!route) return { kind: "unavailable", reason: "This tab is not connected to a host." };
    if (this.deps.isLocalHost?.(route.serverId)) return { kind: "local-host" };
    const results: PortForwardStatus[] = [];
    const problems = new Map<number, PortForwardStatus>();
    for (const remotePort of normalizePorts(input.ports)) {
      const existing = this.find(input.browserId, remotePort);
      if (existing) {
        results.push({ state: "forwarding", remotePort, localPort: existing.localPort });
        continue;
      }
      const forwardId = `forward-${this.nextForwardId++}`;
      const bound = await this.deps.native
        .startPortForward(forwardId, remotePort, input.fallbackToAnyPort)
        .catch((error: unknown) => ({ state: "failed" as const, error: errorMessage(error) }));
      if (bound.state === "forwarding") {
        this.forwards.set(forwardId, {
          forwardId,
          browserId: input.browserId,
          route,
          remotePort,
          localPort: bound.localPort,
        });
        results.push({ state: "forwarding", remotePort, localPort: bound.localPort });
      } else {
        const status: PortForwardStatus =
          bound.state === "port-in-use"
            ? { state: "port-in-use", remotePort }
            : { state: "failed", remotePort, error: bound.error };
        problems.set(remotePort, status);
        results.push(status);
      }
    }
    this.lastProblems.set(input.browserId, problems);
    await this.syncService();
    return { kind: "started", forwards: results };
  }

  public async stop(input: { browserId: string; remotePort: number }): Promise<void> {
    const forward = this.find(input.browserId, input.remotePort);
    if (forward) this.stopForward(forward.forwardId, "Forward stopped.");
    await this.syncService();
  }

  public async stopAll(browserId: string): Promise<void> {
    for (const forward of Array.from(this.forwards.values())) {
      if (forward.browserId === browserId) this.stopForward(forward.forwardId, "Tab closed.");
    }
    this.lastProblems.delete(browserId);
    await this.syncService();
  }

  /** The notification's Stop: the native side already closed its listeners. */
  public handleStopRequested(): void {
    for (const forwardId of Array.from(this.forwards.keys())) {
      this.stopForward(forwardId, "Stopped from the notification.");
    }
    this.lastProblems.clear();
    // The service stopped itself; mark it hidden without asking again.
    this.serviceShown = false;
    this.resolveIdle();
  }

  public async list(browserId: string): Promise<PortForwardList> {
    const forwarding = Array.from(this.forwards.values())
      .filter((forward) => forward.browserId === browserId)
      .map(
        (forward): PortForwardStatus => ({
          state: "forwarding",
          remotePort: forward.remotePort,
          localPort: forward.localPort,
        }),
      );
    const covered = new Set(forwarding.map((forward) => forward.remotePort));
    const problems = Array.from(this.lastProblems.get(browserId)?.values() ?? []).filter(
      (problem) => !covered.has(problem.remotePort),
    );
    return {
      forwards: [...forwarding, ...problems].sort((a, b) => a.remotePort - b.remotePort),
      observedPorts: [],
    };
  }

  public get openForwardCount(): number {
    return this.forwards.size;
  }

  /** Resolves once no forward is open: the headless keep-alive task's lifetime. */
  public whenIdle(): Promise<void> {
    if (this.forwards.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  public handleConnectionOpen(event: ForwardConnectionOpenEvent): void {
    const forward = this.forwards.get(event.forwardId);
    if (!forward) {
      this.deps.native.closeForwardConnection(event.connectionId, "Forward stopped.");
      return;
    }
    const connection: ActiveConnection = {
      forwardId: forward.forwardId,
      tunnel: null,
      dispose: () => {},
      closed: false,
    };
    this.connections.set(event.connectionId, connection);
    void this.attachTunnel(event.connectionId, forward, connection);
  }

  private async attachTunnel(
    connectionId: string,
    forward: ActiveForward,
    connection: ActiveConnection,
  ): Promise<void> {
    let tunnel: ForwardTunnel;
    try {
      tunnel = await this.deps.openTunnel({
        serverId: forward.route.serverId,
        port: forward.remotePort,
      });
    } catch (error: unknown) {
      this.closeConnection(connectionId, errorMessage(error), { closeTunnel: false });
      return;
    }
    if (connection.closed || !this.forwards.has(forward.forwardId)) {
      tunnel.close("Forward stopped.");
      return;
    }
    connection.tunnel = tunnel;
    const disposeData = tunnel.onData((data) => {
      this.deps.native.writeForwardConnection(connectionId, this.deps.encodeBase64(data));
    });
    const disposeClose = tunnel.onClose((reason) => {
      this.closeConnection(connectionId, reason, { closeTunnel: false });
    });
    connection.dispose = () => {
      disposeData();
      disposeClose();
    };
    this.deps.native.acceptForwardConnection(connectionId);
  }

  public handleConnectionData(event: ForwardConnectionDataEvent): void {
    const tunnel = this.connections.get(event.connectionId)?.tunnel;
    if (!tunnel) return;
    try {
      tunnel.write(this.deps.decodeBase64(event.binaryBase64));
    } catch (error: unknown) {
      this.closeConnection(event.connectionId, errorMessage(error), { closeTunnel: true });
    }
  }

  /** The phone's browser closed its socket. */
  public handleConnectionClose(event: ForwardConnectionCloseEvent): void {
    const connection = this.connections.get(event.connectionId);
    if (!connection) return;
    connection.closed = true;
    this.connections.delete(event.connectionId);
    connection.dispose();
    connection.tunnel?.close(event.reason ?? "Closed on this phone.");
  }

  private closeConnection(
    connectionId: string,
    reason: string,
    options: { closeTunnel: boolean },
  ): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.closed = true;
    this.connections.delete(connectionId);
    connection.dispose();
    if (options.closeTunnel) connection.tunnel?.close(reason);
    this.deps.native.closeForwardConnection(connectionId, reason);
  }

  private stopForward(forwardId: string, reason: string): void {
    if (!this.forwards.delete(forwardId)) return;
    for (const [connectionId, connection] of Array.from(this.connections)) {
      if (connection.forwardId === forwardId) {
        this.closeConnection(connectionId, reason, { closeTunnel: true });
      }
    }
    this.deps.native.stopPortForward(forwardId);
  }

  /** Shows the service while any forward is open and hides it after the last one. */
  private syncService(): Promise<void> {
    this.serviceChange = this.serviceChange.then(() => this.applyService());
    return this.serviceChange;
  }

  private async applyService(): Promise<void> {
    const wanted = this.forwards.size > 0;
    if (wanted && !this.serviceShown) {
      this.serviceShown = true;
      try {
        await this.deps.service.show();
      } catch (error: unknown) {
        // Without the service Android may freeze Paseo behind the browser; keep forwarding
        // while it is in front rather than failing the user's request.
        this.serviceShown = false;
        console.warn("[port-forward] foreground service failed to start", error);
      }
    } else if (!wanted && this.serviceShown) {
      this.serviceShown = false;
      this.deps.service.hide();
    }
    if (!wanted) this.resolveIdle();
  }

  private resolveIdle(): void {
    for (const resolve of Array.from(this.idleWaiters)) resolve();
    this.idleWaiters.clear();
  }

  private find(browserId: string, remotePort: number): ActiveForward | undefined {
    return Array.from(this.forwards.values()).find(
      (forward) => forward.browserId === browserId && forward.remotePort === remotePort,
    );
  }

  private routeOf(browserId: string): PortForwardRoute | null {
    return (
      Array.from(this.forwards.values()).find((forward) => forward.browserId === browserId)
        ?.route ?? null
    );
  }
}

function normalizePorts(ports: readonly number[]): number[] {
  return Array.from(
    new Set(ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)),
  ).sort((a, b) => a - b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
