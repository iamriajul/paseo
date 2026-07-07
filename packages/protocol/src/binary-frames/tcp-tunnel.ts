import { asUint8Array } from "./terminal.js";

export const TcpTunnelOpcode = {
  Open: 0x20,
  OpenResult: 0x21,
  Data: 0x22,
  Close: 0x23,
} as const;

export type TcpTunnelOpcode = (typeof TcpTunnelOpcode)[keyof typeof TcpTunnelOpcode];

export const TcpTunnelTargetHost = {
  Ipv4Loopback: 0x00,
  Ipv6Loopback: 0x01,
} as const;

export type TcpTunnelTargetHost = (typeof TcpTunnelTargetHost)[keyof typeof TcpTunnelTargetHost];

export interface TcpTunnelOpenFrame {
  opcode: typeof TcpTunnelOpcode.Open;
  streamId: number;
  port: number;
  targetHost: TcpTunnelTargetHost;
}

export interface TcpTunnelOpenResultFrame {
  opcode: typeof TcpTunnelOpcode.OpenResult;
  streamId: number;
  ok: boolean;
  message: string;
}

export interface TcpTunnelDataFrame {
  opcode: typeof TcpTunnelOpcode.Data;
  streamId: number;
  payload: Uint8Array;
}

export interface TcpTunnelCloseFrame {
  opcode: typeof TcpTunnelOpcode.Close;
  streamId: number;
  reason: string;
}

export type TcpTunnelFrame =
  | TcpTunnelOpenFrame
  | TcpTunnelOpenResultFrame
  | TcpTunnelDataFrame
  | TcpTunnelCloseFrame;

type TcpTunnelFrameInput =
  | (Omit<TcpTunnelOpenFrame, "targetHost"> & { targetHost?: TcpTunnelTargetHost })
  | TcpTunnelOpenResultFrame
  | {
      opcode: typeof TcpTunnelOpcode.Data;
      streamId: number;
      payload?: Uint8Array | ArrayBuffer | string;
    }
  | TcpTunnelCloseFrame;

const HEADER_BYTES = 5;
const LEGACY_OPEN_FRAME_BYTES = 7;
const OPEN_FRAME_BYTES = 8;

export function encodeTcpTunnelFrame(input: TcpTunnelFrameInput): Uint8Array {
  const streamId = normalizeStreamId(input.streamId);

  if (input.opcode === TcpTunnelOpcode.Open) {
    const port = normalizePort(input.port);
    const targetHost = normalizeTargetHost(input.targetHost ?? TcpTunnelTargetHost.Ipv4Loopback);
    const bytes = new Uint8Array(OPEN_FRAME_BYTES);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    bytes[0] = input.opcode;
    view.setUint32(1, streamId);
    view.setUint16(5, port);
    bytes[7] = targetHost;
    return bytes;
  }

  if (input.opcode === TcpTunnelOpcode.OpenResult) {
    const message = encodeText(input.message);
    const bytes = new Uint8Array(HEADER_BYTES + 1 + message.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    bytes[0] = input.opcode;
    view.setUint32(1, streamId);
    bytes[5] = input.ok ? 1 : 0;
    bytes.set(message, 6);
    return bytes;
  }

  if (input.opcode === TcpTunnelOpcode.Data) {
    const payload = asUint8Array(input.payload ?? new Uint8Array()) ?? new Uint8Array();
    const bytes = new Uint8Array(HEADER_BYTES + payload.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    bytes[0] = input.opcode;
    view.setUint32(1, streamId);
    bytes.set(payload, HEADER_BYTES);
    return bytes;
  }

  const reason = encodeText(input.reason);
  const bytes = new Uint8Array(HEADER_BYTES + reason.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes[0] = input.opcode;
  view.setUint32(1, streamId);
  bytes.set(reason, HEADER_BYTES);
  return bytes;
}

export function decodeTcpTunnelFrame(bytes: Uint8Array): TcpTunnelFrame | null {
  if (bytes.byteLength < HEADER_BYTES) {
    return null;
  }
  const opcode = bytes[0];
  if (!isTcpTunnelOpcode(opcode)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streamId = view.getUint32(1);
  if (!Number.isSafeInteger(streamId) || streamId <= 0) {
    return null;
  }

  if (opcode === TcpTunnelOpcode.Open) {
    if (bytes.byteLength !== LEGACY_OPEN_FRAME_BYTES && bytes.byteLength !== OPEN_FRAME_BYTES) {
      return null;
    }
    const port = view.getUint16(5);
    if (port < 1 || port > 65535) {
      return null;
    }
    const targetHost =
      bytes.byteLength === OPEN_FRAME_BYTES
        ? decodeTargetHost(bytes[7])
        : TcpTunnelTargetHost.Ipv4Loopback;
    if (targetHost === null) {
      return null;
    }
    return { opcode, streamId, port, targetHost };
  }

  if (opcode === TcpTunnelOpcode.OpenResult) {
    if (bytes.byteLength < HEADER_BYTES + 1) {
      return null;
    }
    return {
      opcode,
      streamId,
      ok: bytes[5] === 1,
      message: decodeText(bytes.subarray(6)),
    };
  }

  if (opcode === TcpTunnelOpcode.Data) {
    return { opcode, streamId, payload: bytes.subarray(HEADER_BYTES) };
  }

  return { opcode, streamId, reason: decodeText(bytes.subarray(HEADER_BYTES)) };
}

function normalizeStreamId(streamId: number): number {
  if (!Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0xffffffff) {
    throw new RangeError("TCP tunnel streamId must be a positive uint32");
  }
  return streamId;
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("TCP tunnel port must be between 1 and 65535");
  }
  return port;
}

function normalizeTargetHost(targetHost: number): TcpTunnelTargetHost {
  if (
    targetHost !== TcpTunnelTargetHost.Ipv4Loopback &&
    targetHost !== TcpTunnelTargetHost.Ipv6Loopback
  ) {
    throw new RangeError("TCP tunnel targetHost must be a known loopback target");
  }
  return targetHost;
}

function decodeTargetHost(targetHost: number | undefined): TcpTunnelTargetHost | null {
  if (
    targetHost !== TcpTunnelTargetHost.Ipv4Loopback &&
    targetHost !== TcpTunnelTargetHost.Ipv6Loopback
  ) {
    return null;
  }
  return targetHost;
}

function isTcpTunnelOpcode(value: number): value is TcpTunnelOpcode {
  return (
    value === TcpTunnelOpcode.Open ||
    value === TcpTunnelOpcode.OpenResult ||
    value === TcpTunnelOpcode.Data ||
    value === TcpTunnelOpcode.Close
  );
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
