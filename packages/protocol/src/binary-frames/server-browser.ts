export const ServerBrowserOpcode = {
  /** daemon → client: one JPEG screencast frame. */
  Frame: 0x40,
  /** client → daemon: frees one credit of the stream's flow-control window. */
  FrameAck: 0x41,
} as const;

export interface ServerBrowserFrameFrame {
  opcode: typeof ServerBrowserOpcode.Frame;
  streamId: number;
  seq: number;
  /** CSS-pixel size of the page the frame shows. */
  width: number;
  height: number;
  jpeg: Uint8Array;
}

export interface ServerBrowserFrameAckFrame {
  opcode: typeof ServerBrowserOpcode.FrameAck;
  streamId: number;
  seq: number;
}

export type ServerBrowserBinaryFrame = ServerBrowserFrameFrame | ServerBrowserFrameAckFrame;

const FRAME_HEADER_BYTES = 13;
const ACK_BYTES = 9;

export function encodeServerBrowserFrame(
  input: Omit<ServerBrowserFrameFrame, "opcode">,
): Uint8Array {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + input.jpeg.byteLength);
  const view = new DataView(bytes.buffer);
  bytes[0] = ServerBrowserOpcode.Frame;
  view.setUint32(1, input.streamId >>> 0);
  view.setUint32(5, input.seq >>> 0);
  view.setUint16(9, clampUint16(input.width));
  view.setUint16(11, clampUint16(input.height));
  bytes.set(input.jpeg, FRAME_HEADER_BYTES);
  return bytes;
}

export function encodeServerBrowserFrameAck(input: { streamId: number; seq: number }): Uint8Array {
  const bytes = new Uint8Array(ACK_BYTES);
  const view = new DataView(bytes.buffer);
  bytes[0] = ServerBrowserOpcode.FrameAck;
  view.setUint32(1, input.streamId >>> 0);
  view.setUint32(5, input.seq >>> 0);
  return bytes;
}

export function decodeServerBrowserFrame(bytes: Uint8Array): ServerBrowserBinaryFrame | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === ServerBrowserOpcode.Frame) {
    if (bytes.byteLength < FRAME_HEADER_BYTES) return null;
    return {
      opcode: ServerBrowserOpcode.Frame,
      streamId: view.getUint32(1),
      seq: view.getUint32(5),
      width: view.getUint16(9),
      height: view.getUint16(11),
      jpeg: bytes.subarray(FRAME_HEADER_BYTES),
    };
  }
  if (bytes[0] === ServerBrowserOpcode.FrameAck) {
    if (bytes.byteLength !== ACK_BYTES) return null;
    return {
      opcode: ServerBrowserOpcode.FrameAck,
      streamId: view.getUint32(1),
      seq: view.getUint32(5),
    };
  }
  return null;
}

function clampUint16(value: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(value)));
}
