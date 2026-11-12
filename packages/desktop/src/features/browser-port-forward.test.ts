import { createConnection, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserPortForwards } from "./browser-port-forward";
import type { BrowserLoopbackRoute } from "./browser-loopback-proxy";

const remoteRoute: BrowserLoopbackRoute = {
  rendererWebContentsId: 1,
  browserId: "tab-1",
  serverId: "remote-host",
  workspaceId: "ws-1",
  directLoopback: false,
};

const servers: Server[] = [];
const openSockets = new Set<Socket>();

async function startEchoServer(): Promise<number> {
  const server = createServer((socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    socket.pipe(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Stands in for the daemon tunnel: relays to 127.0.0.1:<echoPort> on this machine. */
function relayTo(echoPort: number, relayed: number[]) {
  return async (input: { socket: Socket; port: number }) => {
    relayed.push(input.port);
    const upstream = createConnection({ host: "127.0.0.1", port: echoPort });
    input.socket.pipe(upstream);
    upstream.pipe(input.socket);
  };
}

async function roundTrip(port: number, text: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => socket.write(text));
    socket.once("data", (data) => {
      resolve(data.toString());
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

afterEach(async () => {
  for (const socket of openSockets) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("browser port forwards", () => {
  test("binds the same local port and relays connections to the host port", async () => {
    const echoPort = await startEchoServer();
    const remotePort = await freePort();
    const relayed: number[] = [];
    const forwards = new BrowserPortForwards({
      resolveRoute: () => remoteRoute,
      relay: relayTo(echoPort, relayed),
    });

    const result = await forwards.start({ browserId: "tab-1", ports: [remotePort] });

    expect(result).toEqual({
      kind: "started",
      forwards: [{ state: "forwarding", remotePort, localPort: remotePort }],
    });
    expect(await roundTrip(remotePort, "hello")).toBe("hello");
    expect(relayed).toEqual([remotePort]);
    expect(forwards.list("tab-1")).toEqual([
      { state: "forwarding", remotePort, localPort: remotePort },
    ]);
    await forwards.stopAll("tab-1");
    expect(forwards.list("tab-1")).toEqual([]);
  });

  test("reports a taken local port, and picks another only when asked", async () => {
    const takenPort = await startEchoServer();
    const forwards = new BrowserPortForwards({
      resolveRoute: () => remoteRoute,
      relay: relayTo(takenPort, []),
    });

    expect(await forwards.start({ browserId: "tab-1", ports: [takenPort] })).toEqual({
      kind: "started",
      forwards: [{ state: "port-in-use", remotePort: takenPort }],
    });

    const fallback = await forwards.start({
      browserId: "tab-1",
      ports: [takenPort],
      fallbackToAnyPort: true,
    });
    expect(fallback.kind).toBe("started");
    const forward = fallback.kind === "started" ? fallback.forwards[0] : null;
    expect(forward?.state).toBe("forwarding");
    const localPort = forward?.state === "forwarding" ? forward.localPort : 0;
    expect(localPort).not.toBe(takenPort);
    expect(await roundTrip(localPort, "ping")).toBe("ping");
    await forwards.stopAll("tab-1");
  });

  test("does nothing for a host that is this machine", async () => {
    const forwards = new BrowserPortForwards({
      resolveRoute: () => ({ ...remoteRoute, directLoopback: true }),
      relay: async () => undefined,
    });
    expect(await forwards.start({ browserId: "tab-1", ports: [3000] })).toEqual({
      kind: "local-host",
    });
  });

  test("forwards a tab with no webview here on the route the renderer gave, until it stops", async () => {
    const echoPort = await startEchoServer();
    const remotePort = await freePort();
    const relayed: number[] = [];
    const routes: string[] = [];
    const forwards = new BrowserPortForwards({
      // A server browser tab never registers a loopback proxy.
      resolveRoute: () => null,
      relay: async (input) => {
        routes.push(input.route.serverId);
        await relayTo(echoPort, relayed)(input);
      },
    });
    const serverTabRoute = { ...remoteRoute, browserId: "server-tab", rendererWebContentsId: 7 };

    expect(await forwards.start({ browserId: "server-tab", ports: [remotePort] })).toEqual({
      kind: "unavailable",
      reason: "This Browser tab is not connected to a host.",
    });
    const result = await forwards.start({
      browserId: "server-tab",
      ports: [remotePort],
      route: serverTabRoute,
    });
    expect(result.kind).toBe("started");
    expect(await roundTrip(remotePort, "hello")).toBe("hello");
    expect(routes).toEqual(["remote-host"]);

    await forwards.stopAllForRenderer(7);
    expect(forwards.list("server-tab")).toEqual([]);
    await expect(roundTrip(remotePort, "gone")).rejects.toThrow();
    // The route went with the forwards: a later start without one has nowhere to go.
    expect((await forwards.start({ browserId: "server-tab", ports: [remotePort] })).kind).toBe(
      "unavailable",
    );
  });

  test("opens a server tab directly when the route it was given is this machine", async () => {
    const forwards = new BrowserPortForwards({
      resolveRoute: () => null,
      relay: async () => undefined,
    });
    expect(
      await forwards.start({
        browserId: "server-tab",
        ports: [3000],
        route: { ...remoteRoute, directLoopback: true },
      }),
    ).toEqual({ kind: "local-host" });
  });

  test("closes a port still binding when the window that started it closes", async () => {
    const forwards = new BrowserPortForwards({
      resolveRoute: () => null,
      relay: async () => undefined,
    });
    const [first, second] = [await freePort(), await freePort()];
    const starting = forwards.start({
      browserId: "server-tab",
      ports: [first, second],
      route: { ...remoteRoute, browserId: "server-tab", rendererWebContentsId: 9 },
    });
    // The renderer goes away before the listeners have bound.
    await forwards.stopAllForRenderer(9);
    await starting;

    expect(forwards.list("server-tab")).toEqual([]);
    for (const port of [first, second]) {
      await expect(roundTrip(port, "orphan")).rejects.toThrow(/ECONNREFUSED/);
    }
  });
});
