import { createServer, type Server } from "node:net";

/**
 * Reserve and release an ephemeral TCP port, returning the port number.
 * Tests can use this to reduce port collision flakiness when spawning daemons.
 */
export async function getAvailablePort(): Promise<number> {
  const [port] = await getAvailablePorts(1);
  return port!;
}

/**
 * Reserve `count` distinct ephemeral TCP ports, then release them all. Every port stays bound
 * until the last one is, so the kernel cannot hand the same port out twice, which two separate
 * `getAvailablePort()` calls can do.
 */
export async function getAvailablePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    const ports: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const server = createServer();
      server.unref();
      servers.push(server);
      ports.push(await listenOnEphemeralPort(server));
    }
    return ports;
  } finally {
    await Promise.all(servers.map(closeServer));
  }
}

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve an available TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
