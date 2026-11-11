import { describe, expect, it } from "vitest";
import { parseAccessUnit, splitAnnexB, toAnnexB, toAvcc } from "./h264-annexb";
import { nativeVideoCodecs, prepareNativeSample } from "./native-video-port";

const AUD = [0x09, 0xf0];
const SPS = [0x67, 0x42, 0xc0, 0x28, 0xda, 0x01, 0x40];
const PPS = [0x68, 0xce, 0x3c, 0x80];
const IDR = [0x65, 0x88, 0x84, 0x00, 0x21];
const SLICE = [0x41, 0x9a, 0x02, 0x03];

/** A keyframe as the daemon sends it: 4-byte and 3-byte start codes, a trailing zero byte. */
function keyframe(): Uint8Array {
  return new Uint8Array([
    0,
    0,
    0,
    1,
    ...AUD,
    0,
    0,
    0,
    1,
    ...SPS,
    0,
    0,
    1,
    ...PPS,
    0,
    0,
    0,
    1,
    ...IDR,
    0x00,
  ]);
}

describe("splitAnnexB", () => {
  it("finds every NAL unit behind 3- and 4-byte start codes, without trailing zero bytes", () => {
    expect(splitAnnexB(keyframe()).map((unit) => Array.from(unit))).toEqual([AUD, SPS, PPS, IDR]);
  });

  it("keeps a zero byte inside a unit", () => {
    // IDR contains 0x00 in its middle: only trailing zeros are stripped.
    expect([...(splitAnnexB(new Uint8Array([0, 0, 1, ...IDR]))[0] ?? [])]).toEqual(IDR);
  });
});

describe("parseAccessUnit", () => {
  it("separates the parameter sets from the picture and drops the delimiter", () => {
    const unit = parseAccessUnit(keyframe());
    expect([...(unit.sps ?? [])]).toEqual(SPS);
    expect([...(unit.pps ?? [])]).toEqual(PPS);
    expect(unit.picture.map((nal) => Array.from(nal))).toEqual([IDR]);
    expect(unit.idr).toBe(true);
  });

  it("reads a delta as a picture with no parameter sets", () => {
    const unit = parseAccessUnit(new Uint8Array([0, 0, 0, 1, ...AUD, 0, 0, 0, 1, ...SLICE]));
    expect(unit.sps).toBeNull();
    expect(unit.idr).toBe(false);
    expect(unit.picture.map((nal) => Array.from(nal))).toEqual([SLICE]);
  });
});

describe("framing for the platform decoders", () => {
  it("writes AVCC with 4-byte big-endian lengths for VideoToolbox", () => {
    expect([...toAvcc([new Uint8Array(IDR), new Uint8Array(SLICE)])]).toEqual([
      0,
      0,
      0,
      IDR.length,
      ...IDR,
      0,
      0,
      0,
      SLICE.length,
      ...SLICE,
    ]);
  });

  it("writes Annex B with 4-byte start codes for MediaCodec", () => {
    expect([...toAnnexB([new Uint8Array(IDR)])]).toEqual([0, 0, 0, 1, ...IDR]);
  });

  it("prepares a keyframe per platform, with its parameter sets apart", () => {
    const ios = prepareNativeSample(keyframe(), true, "ios");
    expect([...(ios?.sample ?? [])]).toEqual([0, 0, 0, IDR.length, ...IDR]);
    expect([...(ios?.sps ?? [])]).toEqual(SPS);
    expect([...(ios?.pps ?? [])]).toEqual(PPS);
    const android = prepareNativeSample(keyframe(), true, "android");
    expect([...(android?.sample ?? [])]).toEqual([0, 0, 0, 1, ...IDR]);
    // A copy, not a view into the chunk: the native call reads the whole buffer it is given.
    expect(android?.sps?.byteOffset).toBe(0);
    expect(android?.sps?.buffer.byteLength).toBe(SPS.length);
  });

  it("refuses a keyframe without parameter sets, and a chunk without a picture", () => {
    expect(prepareNativeSample(new Uint8Array([0, 0, 0, 1, ...IDR]), true, "ios")).toBeNull();
    expect(prepareNativeSample(new Uint8Array([0, 0, 0, 1, ...AUD]), false, "ios")).toBeNull();
  });
});

describe("nativeVideoCodecs", () => {
  it("offers H.264 only from a build with the native decoder", () => {
    expect(nativeVideoCodecs(true)).toEqual(["avc1.42E028"]);
    expect(nativeVideoCodecs(false)).toBeNull();
  });
});
