/**
 * H.264 framing for the native decoders. The daemon sends Annex B access units (start codes, SPS
 * and PPS in band before every keyframe). VideoToolbox wants the parameter sets apart and the
 * picture as AVCC (each NAL unit behind a 4-byte big-endian length); MediaCodec takes the
 * parameter sets as csd-0/csd-1 and the picture in Annex B. Both are built here, in TypeScript,
 * so the native layer only hands bytes to the platform decoder.
 */

export const NAL_TYPE = {
  /** Coded slice of an IDR picture. */
  idr: 5,
  sps: 7,
  pps: 8,
  /** Access unit delimiter. */
  aud: 9,
} as const;

/** The NAL units of an Annex B buffer, without their start codes. Views into `data`, not copies. */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const starts: Array<{ at: number; length: number }> = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    if (data[i + 2] === 1) {
      starts.push({ at: i, length: 3 });
      i += 2;
    } else if (data[i + 2] === 0 && data[i + 3] === 1) {
      starts.push({ at: i, length: 4 });
      i += 3;
    }
  }
  const units: Uint8Array[] = [];
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    if (!start) continue;
    const begin = start.at + start.length;
    const end = starts[k + 1]?.at ?? data.length;
    // A NAL unit ends in its stop bit, so trailing zero bytes are trailing_zero_8bits or the
    // first byte of a 4-byte start code, never part of the unit.
    let last = end;
    while (last > begin && data[last - 1] === 0) last--;
    if (last > begin) units.push(data.subarray(begin, last));
  }
  return units;
}

export function nalType(unit: Uint8Array): number {
  return (unit[0] ?? 0) & 0x1f;
}

export interface H264AccessUnit {
  /** Present on a keyframe: the decoder (re)configures from them. */
  sps: Uint8Array | null;
  pps: Uint8Array | null;
  /** The picture's NAL units: no parameter sets, no access unit delimiters. */
  picture: Uint8Array[];
  idr: boolean;
}

export function parseAccessUnit(data: Uint8Array): H264AccessUnit {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let idr = false;
  const picture: Uint8Array[] = [];
  for (const unit of splitAnnexB(data)) {
    const type = nalType(unit);
    if (type === NAL_TYPE.sps) sps = unit;
    else if (type === NAL_TYPE.pps) pps = unit;
    else if (type !== NAL_TYPE.aud) {
      if (type === NAL_TYPE.idr) idr = true;
      picture.push(unit);
    }
  }
  return { sps, pps, picture, idr };
}

/** NAL units behind 4-byte big-endian lengths, as a CMSampleBuffer for VideoToolbox holds them. */
export function toAvcc(units: Uint8Array[]): Uint8Array {
  const size = units.reduce((total, unit) => total + 4 + unit.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const unit of units) {
    view.setUint32(at, unit.length);
    out.set(unit, at + 4);
    at += 4 + unit.length;
  }
  return out;
}

/** NAL units behind 4-byte start codes, as MediaCodec takes them. */
export function toAnnexB(units: Uint8Array[]): Uint8Array {
  const size = units.reduce((total, unit) => total + 4 + unit.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const unit of units) {
    out.set([0, 0, 0, 1], at);
    out.set(unit, at + 4);
    at += 4 + unit.length;
  }
  return out;
}
