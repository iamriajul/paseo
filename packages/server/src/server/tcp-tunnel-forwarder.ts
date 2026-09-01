import { createConnection, type Socket } from "node:net";
import {
  encodeTcpTunnelFrame,
  TcpTunnelOpcode,
  TcpTunnelTargetHost,
  type TcpTunnelFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type pino from "pino";

interface TcpTunnelForwarderHost {
  emitBinary(frame: Uint8Array): void;
  logger: pino.Logger;
}

interface TcpTunnelStreamState {
  streamId: number;
  socket: Socket;
  opened: boolean;
  closed: boolean;
  closeReason: string;
}

const LOOPBACK_HOST = "127.0.0.1";
const IPV6_LOOPBACK_HOST = "::1";

export class TcpTunnelForwarder {
  private readonly streams = new Map<number, TcpTunnelStreamState>();
  private readonly logger: pino.Logger;

  constructor(private readonly host: TcpTunnelForwarderHost) {
    this.logger = host.logger.child({ module: "tcp-tunnel-forwarder" });
  }

  public handleFrame(frame: TcpTunnelFrame): void {
    switch (frame.opcode) {
      case TcpTunnelOpcode.Open:
        this.open(frame.streamId, frame.port, frame.targetHost);
        return;
      case TcpTunnelOpcode.Data:
        this.write(frame.streamId, frame.payload);
        return;
      case TcpTunnelOpcode.Close:
        this.close(frame.streamId, frame.reason, { notifyClient: false });
        return;
      case TcpTunnelOpcode.OpenResult:
        return;
    }
  }

  public dispose(): void {
    for (const streamId of Array.from(this.streams.keys())) {
      this.close(streamId, "Session closed", { notifyClient: false });
    }
  }

  private open(streamId: number, port: number, targetHost: TcpTunnelTargetHost): void {
    this.close(streamId, "Replacing existing tunnel stream", { notifyClient: false });

    const socket = createConnection({ host: targetHostForFrame(targetHost), port });
    const state: TcpTunnelStreamState = {
      streamId,
      socket,
      opened: false,
      closed: false,
      closeReason: "",
    };
    this.streams.set(streamId, state);

    socket.once("connect", () => {
      if (state.closed) {
        return;
      }
      state.opened = true;
      this.emit({
        opcode: TcpTunnelOpcode.OpenResult,
        streamId,
        ok: true,
        message: "",
      });
    });

    socket.on("data", (chunk: Buffer) => {
      if (state.closed) {
        return;
      }
      this.emit({
        opcode: TcpTunnelOpcode.Data,
        streamId,
        payload: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      });
    });

    socket.once("error", (error) => {
      state.closeReason = error.message;
      if (!state.opened) {
        this.emit({
          opcode: TcpTunnelOpcode.OpenResult,
          streamId,
          ok: false,
          message: error.message,
        });
      }
    });

    socket.once("close", () => {
      if (state.closed) {
        return;
      }
      state.closed = true;
      this.streams.delete(streamId);
      if (state.opened) {
        this.emit({
          opcode: TcpTunnelOpcode.Close,
          streamId,
          reason: state.closeReason,
        });
      }
    });
  }

  private write(streamId: number, payload: Uint8Array): void {
    const state = this.streams.get(streamId);
    if (!state || state.closed) {
      return;
    }
    state.socket.write(payload, (error) => {
      if (error) {
        state.closeReason = error.message;
        this.close(streamId, error.message, { notifyClient: true });
      }
    });
  }

  private close(streamId: number, reason: string, options: { notifyClient: boolean }): void {
    const state = this.streams.get(streamId);
    if (!state || state.closed) {
      return;
    }
    state.closed = true;
    state.closeReason = reason;
    this.streams.delete(streamId);
    try {
      state.socket.destroy();
    } catch (error) {
      this.logger.debug({ err: error, streamId }, "tcp_tunnel_socket_destroy_failed");
    }
    if (options.notifyClient) {
      this.emit({
        opcode: TcpTunnelOpcode.Close,
        streamId,
        reason,
      });
    }
  }

  private emit(frame: TcpTunnelFrame): void {
    try {
      this.host.emitBinary(encodeTcpTunnelFrame(frame));
    } catch (error) {
      this.logger.warn({ err: error }, "tcp_tunnel_emit_failed");
    }
  }
}

function targetHostForFrame(targetHost: TcpTunnelTargetHost): string {
  return targetHost === TcpTunnelTargetHost.Ipv6Loopback ? IPV6_LOOPBACK_HOST : LOOPBACK_HOST;
}
