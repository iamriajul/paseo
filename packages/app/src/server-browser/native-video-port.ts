import type { ServerBrowserVideoChunk } from "@getpaseo/client/internal/daemon-client";
import type { PaseoVideoViewHandle } from "../../modules/paseo-video";
import { parseAccessUnit, toAnnexB, toAvcc } from "./h264-annexb";
import { H264_CODEC, type VideoDecoderPort } from "./video-session";

export type NativeVideoPlatform = "ios" | "android";

/** What the native view's decode() takes for one chunk. */
export interface NativeVideoSample {
  sample: Uint8Array;
  sps: Uint8Array | null;
  pps: Uint8Array | null;
}

/**
 * Codecs the iOS and Android apps ask for: H.264 only, and only from a build with the PaseoVideo
 * module. Without it (an older build) the app asks for JPEG, as before video existed.
 */
export function nativeVideoCodecs(moduleAvailable: boolean): string[] | null {
  return moduleAvailable ? [H264_CODEC] : null;
}

/**
 * Turns one Annex B access unit from the daemon into what the platform decoder takes: AVCC for
 * VideoToolbox, Annex B with 4-byte start codes for MediaCodec, the parameter sets apart. Null for
 * a chunk the decoder cannot use: no picture, or a keyframe without its SPS and PPS.
 */
export function prepareNativeSample(
  data: Uint8Array,
  key: boolean,
  platform: NativeVideoPlatform,
): NativeVideoSample | null {
  const unit = parseAccessUnit(data);
  if (unit.picture.length === 0) return null;
  if (key && (!unit.sps || !unit.pps)) return null;
  return {
    sample: platform === "ios" ? toAvcc(unit.picture) : toAnnexB(unit.picture),
    // Copies: the native call takes the whole Uint8Array's buffer, not a view's slice of it.
    sps: unit.sps ? unit.sps.slice() : null,
    pps: unit.pps ? unit.pps.slice() : null,
  };
}

/** The session's decoder, backed by the PaseoVideo native view. */
export class NativeVideoPort implements VideoDecoderPort {
  public constructor(
    private readonly view: () => PaseoVideoViewHandle | null,
    private readonly platform: NativeVideoPlatform,
    private readonly onError: () => void,
  ) {}

  public decode(id: number, chunk: ServerBrowserVideoChunk): void {
    const view = this.view();
    const prepared = prepareNativeSample(chunk.data, chunk.key, this.platform);
    if (!view || !prepared) {
      this.onError();
      return;
    }
    view
      .decode(id, prepared.sample, chunk.key, prepared.sps, prepared.pps)
      .catch(() => this.onError());
  }

  public reset(): void {
    void this.view()
      ?.reset()
      .catch(() => {});
  }
}
