import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import {
  TcpTunnelOpcode,
  TcpTunnelTargetHost,
  decodeTcpTunnelFrame,
  type TcpTunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { TcpTunnelForwarder } from "./tcp-tunnel-forwarder.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("TcpTunnelForwarder", () => {
  test("opens a loopback connection and relays bytes", async () => {
    const echoServer = createServer(handleEchoConnection);
    servers.push(echoServer);
    const port = await listen(echoServer);
    const emitted: TcpTunnelFrame[] = [];
    const forwarder = new TcpTunnelForwarder({
      emitBinary: (frame) => {
        const decoded = decodeTcpTunnelFrame(frame);
        if (decoded) {
          emitted.push(decoded);
        }
      },
      logger: pino({ level: "silent" }),
    });

    forwarder.handleFrame({
      opcode: TcpTunnelOpcode.Open,
      streamId: 1,
      port,
      targetHost: TcpTunnelTargetHost.Ipv4Loopback,
    });

    await waitFor(() => hasOpenResult(emitted, 1, true));

    forwarder.handleFrame({
      opcode: TcpTunnelOpcode.Data,
      streamId: 1,
      payload: new TextEncoder().encode("hello"),
    });

    await waitFor(() => hasDataFrame(emitted, 1, "hello"));

    forwarder.handleFrame({
      opcode: TcpTunnelOpcode.Close,
      streamId: 1,
      reason: "done",
    });
    forwarder.dispose();
  });

  test("emits an open failure when the port is unreachable", async () => {
    const emitted: TcpTunnelFrame[] = [];
    const port = await reserveClosedLoopbackPort();
    const forwarder = new TcpTunnelForwarder({
      emitBinary: (frame) => {
        const decoded = decodeTcpTunnelFrame(frame);
        if (decoded) {
          emitted.push(decoded);
        }
      },
      logger: pino({ level: "silent" }),
    });

    forwarder.handleFrame({
      opcode: TcpTunnelOpcode.Open,
      streamId: 2,
      port,
      targetHost: TcpTunnelTargetHost.Ipv4Loopback,
    });

    await waitFor(() => hasOpenResult(emitted, 2, false));
    forwarder.dispose();
  });
});

function handleEchoConnection(socket: Socket): void {
  socket.pipe(socket);
}

function hasOpenResult(frames: TcpTunnelFrame[], streamId: number, ok: boolean): boolean {
  return frames.some(
    (frame) =>
      frame.opcode === TcpTunnelOpcode.OpenResult && frame.streamId === streamId && frame.ok === ok,
  );
}

function hasDataFrame(frames: TcpTunnelFrame[], streamId: number, text: string): boolean {
  return frames.some(
    (frame) =>
      frame.opcode === TcpTunnelOpcode.Data &&
      frame.streamId === streamId &&
      new TextDecoder().decode(frame.payload) === text,
  );
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
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
    server.listen(0, "127.0.0.1");
  });
}

async function reserveClosedLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
