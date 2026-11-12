import { describe, expect, it } from "vitest";
import {
  MobilePortForwards,
  type ForwardTunnel,
  type MobilePortForwardDeps,
  type NativePortForwards,
} from "./mobile-port-forwards";

const route = { serverId: "host-1", workspaceId: "ws-1" };
const text = new TextEncoder();
const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const toBase64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

class FakeTunnel implements ForwardTunnel {
  written: string[] = [];
  closedWith: string | null = null;
  private dataHandlers = new Set<(data: Uint8Array) => void>();
  private closeHandlers = new Set<(reason: string) => void>();
  write(data: Uint8Array): void {
    this.written.push(Buffer.from(data).toString());
  }
  close(reason?: string): void {
    this.closedWith = reason ?? "";
  }
  onData(handler: (data: Uint8Array) => void) {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }
  onClose(handler: (reason: string) => void) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
  emitData(value: string) {
    for (const handler of this.dataHandlers) handler(text.encode(value));
  }
  emitClose(reason: string) {
    for (const handler of this.closeHandlers) handler(reason);
  }
}

function setup(
  options: { taken?: number[]; openTunnel?: MobilePortForwardDeps["openTunnel"] } = {},
) {
  const bound = new Map<string, number>();
  const log: string[] = [];
  const toPhone: Array<{ connectionId: string; text: string }> = [];
  const native: NativePortForwards = {
    startPortForward: async (forwardId, port, fallback) => {
      if (options.taken?.includes(port)) {
        if (!fallback) return { state: "port-in-use" };
        bound.set(forwardId, 40000 + port);
        return { state: "forwarding", localPort: 40000 + port };
      }
      bound.set(forwardId, port);
      return { state: "forwarding", localPort: port };
    },
    stopPortForward: (forwardId) => {
      bound.delete(forwardId);
      log.push(`stop ${forwardId}`);
    },
    acceptForwardConnection: (connectionId) => log.push(`accept ${connectionId}`),
    writeForwardConnection: (connectionId, base64) =>
      toPhone.push({ connectionId, text: Buffer.from(base64, "base64").toString() }),
    closeForwardConnection: (connectionId, reason) =>
      log.push(`close ${connectionId}: ${reason ?? ""}`),
  };
  const tunnels: Array<{ port: number; tunnel: FakeTunnel }> = [];
  const service = { shown: 0, hidden: 0 };
  const deps: MobilePortForwardDeps = {
    native,
    openTunnel:
      options.openTunnel ??
      (async ({ port }) => {
        const tunnel = new FakeTunnel();
        tunnels.push({ port, tunnel });
        return tunnel;
      }),
    service: {
      show: async () => {
        service.shown += 1;
      },
      hide: () => {
        service.hidden += 1;
      },
    },
    encodeBase64: toBase64,
    decodeBase64: fromBase64,
  };
  return { forwards: new MobilePortForwards(deps), bound, log, toPhone, tunnels, service };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MobilePortForwards", () => {
  it("binds each port at the same number on the phone and lists them for the menu", async () => {
    const { forwards, bound } = setup();
    const result = await forwards.start({
      browserId: "tab-1",
      ports: [5173, 8080, 5173, 0],
      fallbackToAnyPort: false,
      route,
    });
    expect(result).toEqual({
      kind: "started",
      forwards: [
        { state: "forwarding", remotePort: 5173, localPort: 5173 },
        { state: "forwarding", remotePort: 8080, localPort: 8080 },
      ],
    });
    expect([...bound.values()]).toEqual([5173, 8080]);
    // A second start reuses the listeners.
    await forwards.start({ browserId: "tab-1", ports: [5173], fallbackToAnyPort: false, route });
    expect(bound.size).toBe(2);
    expect((await forwards.list("tab-1")).forwards.map((forward) => forward.remotePort)).toEqual([
      5173, 8080,
    ]);
  });

  it("reports a port taken on the phone, and binds a free one when asked", async () => {
    const { forwards } = setup({ taken: [3000] });
    const first = await forwards.start({
      browserId: "tab-1",
      ports: [3000],
      fallbackToAnyPort: false,
      route,
    });
    expect(first).toEqual({
      kind: "started",
      forwards: [{ state: "port-in-use", remotePort: 3000 }],
    });
    expect((await forwards.list("tab-1")).forwards).toEqual([
      { state: "port-in-use", remotePort: 3000 },
    ]);
    const fallback = await forwards.start({
      browserId: "tab-1",
      ports: [3000],
      fallbackToAnyPort: true,
      route,
    });
    expect(fallback).toEqual({
      kind: "started",
      forwards: [{ state: "forwarding", remotePort: 3000, localPort: 43000 }],
    });
  });

  it("relays a connection through a tunnel to the host port, reading only once it is open", async () => {
    const { forwards, log, toPhone, tunnels } = setup();
    await forwards.start({ browserId: "tab-1", ports: [8080], fallbackToAnyPort: false, route });
    forwards.handleConnectionOpen({ forwardId: "forward-1", connectionId: "c1" });
    expect(log).toEqual([]);
    await flush();
    expect(tunnels.map((entry) => entry.port)).toEqual([8080]);
    expect(log).toEqual(["accept c1"]);

    forwards.handleConnectionData({
      connectionId: "c1",
      binaryBase64: toBase64(text.encode("GET")),
    });
    const tunnel = tunnels[0]!.tunnel;
    expect(tunnel.written).toEqual(["GET"]);
    tunnel.emitData("200 OK");
    expect(toPhone).toEqual([{ connectionId: "c1", text: "200 OK" }]);

    tunnel.emitClose("host closed");
    expect(log).toContain("close c1: host closed");
  });

  it("closes the phone's socket when the tunnel cannot open", async () => {
    const { forwards: failing, log } = setup({
      openTunnel: async () => {
        throw new Error("Update the host to use Browser.");
      },
    });
    await failing.start({ browserId: "tab-1", ports: [8080], fallbackToAnyPort: false, route });
    failing.handleConnectionOpen({ forwardId: "forward-1", connectionId: "c1" });
    await flush();
    expect(log).toEqual(["close c1: Update the host to use Browser."]);
  });

  it("runs the foreground service exactly while a forward is open", async () => {
    const { forwards, service } = setup();
    await forwards.start({ browserId: "tab-1", ports: [3000], fallbackToAnyPort: false, route });
    await forwards.start({ browserId: "tab-2", ports: [4000], fallbackToAnyPort: false, route });
    expect(service).toEqual({ shown: 1, hidden: 0 });
    const idle = forwards.whenIdle();
    let isIdle = false;
    void idle.then(() => {
      isIdle = true;
      return undefined;
    });

    await forwards.stop({ browserId: "tab-1", remotePort: 3000 });
    expect(service).toEqual({ shown: 1, hidden: 0 });
    await forwards.stopAll("tab-2");
    expect(service).toEqual({ shown: 1, hidden: 1 });
    await flush();
    expect(isIdle).toBe(true);
    expect(forwards.openForwardCount).toBe(0);

    // A tab whose host ports are all taken opens nothing, so no service either.
    const busy = setup({ taken: [3000] });
    await busy.forwards.start({
      browserId: "tab-1",
      ports: [3000],
      fallbackToAnyPort: false,
      route,
    });
    expect(busy.service).toEqual({ shown: 0, hidden: 0 });
  });

  it("tears down a tab's listeners and open connections when the tab ends", async () => {
    const { forwards, log, tunnels, bound } = setup();
    await forwards.start({ browserId: "tab-1", ports: [3000], fallbackToAnyPort: false, route });
    forwards.handleConnectionOpen({ forwardId: "forward-1", connectionId: "c1" });
    await flush();
    await forwards.stopAll("tab-1");
    expect(bound.size).toBe(0);
    expect(tunnels[0]!.tunnel.closedWith).toBe("Tab closed.");
    expect(log).toEqual(["accept c1", "close c1: Tab closed.", "stop forward-1"]);
    // A connection the listener accepted just before it closed gets no tunnel.
    forwards.handleConnectionOpen({ forwardId: "forward-1", connectionId: "c2" });
    expect(log.at(-1)).toBe("close c2: Forward stopped.");
  });

  it("drops every forward when the notification's Stop ends them natively", async () => {
    const { forwards, service } = setup();
    await forwards.start({
      browserId: "tab-1",
      ports: [3000, 4000],
      fallbackToAnyPort: false,
      route,
    });
    forwards.handleStopRequested();
    expect(forwards.openForwardCount).toBe(0);
    expect((await forwards.list("tab-1")).forwards).toEqual([]);
    // The service stopped itself; starting again shows it again.
    await forwards.start({ browserId: "tab-1", ports: [3000], fallbackToAnyPort: false, route });
    expect(service.shown).toBe(2);
    expect(service.hidden).toBe(0);
  });

  it("closes the host tunnel when the phone's browser closes its socket", async () => {
    const { forwards, tunnels } = setup();
    await forwards.start({ browserId: "tab-1", ports: [3000], fallbackToAnyPort: false, route });
    forwards.handleConnectionOpen({ forwardId: "forward-1", connectionId: "c1" });
    await flush();
    forwards.handleConnectionClose({ connectionId: "c1", reason: "browser closed" });
    expect(tunnels[0]!.tunnel.closedWith).toBe("browser closed");
  });
});
