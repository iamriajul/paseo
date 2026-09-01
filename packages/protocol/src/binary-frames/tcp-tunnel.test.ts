import { describe, expect, it } from "vitest";

import {
  TcpTunnelOpcode,
  TcpTunnelTargetHost,
  decodeTcpTunnelFrame,
  encodeTcpTunnelFrame,
} from "./index.js";

describe("TCP tunnel binary frames", () => {
  it("round-trips open frames", () => {
    const encoded = encodeTcpTunnelFrame({
      opcode: TcpTunnelOpcode.Open,
      streamId: 42,
      port: 5173,
    });

    expect(encoded[0]).toBe(TcpTunnelOpcode.Open);
    expect(decodeTcpTunnelFrame(encoded)).toEqual({
      opcode: TcpTunnelOpcode.Open,
      streamId: 42,
      port: 5173,
      targetHost: TcpTunnelTargetHost.Ipv4Loopback,
    });
  });

  it("round-trips IPv6 loopback open frames", () => {
    const encoded = encodeTcpTunnelFrame({
      opcode: TcpTunnelOpcode.Open,
      streamId: 42,
      port: 5173,
      targetHost: TcpTunnelTargetHost.Ipv6Loopback,
    });

    expect(decodeTcpTunnelFrame(encoded)).toEqual({
      opcode: TcpTunnelOpcode.Open,
      streamId: 42,
      port: 5173,
      targetHost: TcpTunnelTargetHost.Ipv6Loopback,
    });
  });

  it("round-trips open result frames", () => {
    const encoded = encodeTcpTunnelFrame({
      opcode: TcpTunnelOpcode.OpenResult,
      streamId: 42,
      ok: false,
      message: "connect refused",
    });

    expect(decodeTcpTunnelFrame(encoded)).toEqual({
      opcode: TcpTunnelOpcode.OpenResult,
      streamId: 42,
      ok: false,
      message: "connect refused",
    });
  });

  it("round-trips data frames", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const encoded = encodeTcpTunnelFrame({
      opcode: TcpTunnelOpcode.Data,
      streamId: 42,
      payload,
    });

    expect(decodeTcpTunnelFrame(encoded)).toEqual({
      opcode: TcpTunnelOpcode.Data,
      streamId: 42,
      payload,
    });
  });

  it("round-trips close frames", () => {
    const encoded = encodeTcpTunnelFrame({
      opcode: TcpTunnelOpcode.Close,
      streamId: 42,
      reason: "done",
    });

    expect(decodeTcpTunnelFrame(encoded)).toEqual({
      opcode: TcpTunnelOpcode.Close,
      streamId: 42,
      reason: "done",
    });
  });
});
