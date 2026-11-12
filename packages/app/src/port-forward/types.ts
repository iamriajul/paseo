/** One forwarded port: a listener on this device's loopback relaying to the tab's host. */
export type PortForwardStatus =
  | { state: "forwarding"; remotePort: number; localPort: number }
  | { state: "port-in-use"; remotePort: number }
  | { state: "failed"; remotePort: number; error: string };

export type PortForwardStartResult =
  | { kind: "local-host" }
  | { kind: "unavailable"; reason: string }
  | { kind: "started"; forwards: PortForwardStatus[] };

export interface PortForwardList {
  forwards: PortForwardStatus[];
  /** Loopback ports this device saw the tab's page use; empty for a tab rendered elsewhere. */
  observedPorts: number[];
}

/**
 * The host a tab's ports live on, for a tab this device does not render itself (a server
 * browser tab). A desktop Browser tab needs none: Electron main already knows its route.
 */
export interface PortForwardRoute {
  serverId: string;
  workspaceId: string;
}

/** Forwards a tab's host ports to this device, keyed by the tab's browserId. */
export interface PortForwardController {
  /** "computer" on desktop, "phone" on a phone: which strings the menu shows. */
  device: "computer" | "phone";
  start(input: {
    browserId: string;
    ports: readonly number[];
    fallbackToAnyPort: boolean;
    route?: PortForwardRoute;
  }): Promise<PortForwardStartResult>;
  stop(input: { browserId: string; remotePort: number }): Promise<void>;
  stopAll(browserId: string): Promise<void>;
  list(browserId: string): Promise<PortForwardList>;
}
