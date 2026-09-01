import { describe, expect, it } from "vitest";

import {
  decodeBinaryFrame,
  encodeFileTransferFrame,
  encodeTcpTunnelFrame,
  encodeTerminalStreamFrame,
  FileTransferOpcode,
  TcpTunnelOpcode,
  TcpTunnelTargetHost,
  TerminalStreamOpcode,
} from "./index.js";

describe("binary frame demux", () => {
  it("routes terminal frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 7,
          payload: "ls",
        }),
      ),
    ).toEqual({
      kind: "terminal",
      frame: {
        opcode: TerminalStreamOpcode.Input,
        slot: 7,
        payload: new TextEncoder().encode("ls"),
      },
    });
  });

  it("routes file-transfer frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId: "req-upload",
          payload: new TextEncoder().encode("hello"),
        }),
      ),
    ).toEqual({
      kind: "file_transfer",
      frame: {
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello"),
      },
    });
  });

  it("routes TCP tunnel frames by opcode", () => {
    expect(
      decodeBinaryFrame(
        encodeTcpTunnelFrame({
          opcode: TcpTunnelOpcode.Open,
          streamId: 99,
          port: 3000,
        }),
      ),
    ).toEqual({
      kind: "tcp_tunnel",
      frame: {
        opcode: TcpTunnelOpcode.Open,
        streamId: 99,
        port: 3000,
        targetHost: TcpTunnelTargetHost.Ipv4Loopback,
      },
    });
  });

  it("rejects unknown binary opcodes", () => {
    expect(decodeBinaryFrame(new Uint8Array([0xff, 0]))).toBeNull();
  });
});
