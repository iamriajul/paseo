import { describe, expect, it } from "vitest";
import { decodeBinaryFrame } from "./demux.js";
import {
  decodeServerBrowserFrame,
  encodeServerBrowserFrameAck,
  encodeServerBrowserVideoChunk,
  encodeServerBrowserVideoKeyframeRequest,
  ServerBrowserOpcode,
} from "./server-browser.js";

describe("server browser video frames", () => {
  it("round-trips a video chunk", () => {
    const data = new Uint8Array([0, 0, 0, 1, 0x67, 0x42]);
    const bytes = encodeServerBrowserVideoChunk({
      streamId: 7,
      seq: 3,
      width: 1280,
      height: 800,
      key: true,
      data,
    });
    expect(decodeServerBrowserFrame(bytes)).toEqual({
      opcode: ServerBrowserOpcode.VideoChunk,
      streamId: 7,
      seq: 3,
      width: 1280,
      height: 800,
      key: true,
      data,
    });
  });

  it("routes the frames a daemon receives from a viewer to the server browser", () => {
    expect(decodeBinaryFrame(encodeServerBrowserVideoKeyframeRequest({ streamId: 9 }))).toEqual({
      kind: "server_browser",
      frame: { opcode: ServerBrowserOpcode.VideoKeyframeRequest, streamId: 9 },
    });
    expect(decodeBinaryFrame(encodeServerBrowserFrameAck({ streamId: 9, seq: 4 }))).toEqual({
      kind: "server_browser",
      frame: { opcode: ServerBrowserOpcode.FrameAck, streamId: 9, seq: 4 },
    });
  });

  it("rejects a truncated keyframe request", () => {
    expect(
      decodeServerBrowserFrame(new Uint8Array([ServerBrowserOpcode.VideoKeyframeRequest, 0])),
    ).toBeNull();
  });
});
