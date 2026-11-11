import type { ServerBrowserVideoChunk } from "@getpaseo/client/internal/daemon-client";

/** Codecs the web viewer asks for, best first. H.264 is Constrained Baseline in Annex B. */
export const WEB_VIDEO_CODECS = ["avc1.42E028", "vp8"];
/** Keyframe requests from a viewer that lost its place, at most this often. */
const KEYFRAME_REQUEST_INTERVAL_MS = 500;

export function webVideoSupported(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
}

/**
 * Decodes a server browser tab's video chunks onto a canvas with WebCodecs. Each chunk is acked
 * when its frame is drawn, so the daemon's window measures the viewer, not just the socket. A
 * decoder error drops everything until the next keyframe, which the player asks the daemon for.
 */
export class ServerBrowserVideoPlayer {
  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;
  private awaitingKey = true;
  private lastKeyframeRequest = Number.NEGATIVE_INFINITY;
  private nextTimestamp = 0;
  private readonly acks = new Map<number, () => void>();

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFrameShown: () => void,
  ) {}

  public push(chunk: ServerBrowserVideoChunk): void {
    if (this.awaitingKey && !chunk.key) {
      chunk.ack();
      this.requestKeyframe(chunk);
      return;
    }
    if (chunk.key) {
      const codec = sniffCodec(chunk.data);
      if (!this.decoder || this.decoder.state === "closed" || codec !== this.codec) {
        this.reset(codec);
      }
    }
    const decoder = this.decoder;
    if (!decoder) {
      chunk.ack();
      return;
    }
    this.awaitingKey = false;
    const timestamp = this.nextTimestamp++;
    this.acks.set(timestamp, chunk.ack);
    try {
      decoder.decode(
        new EncodedVideoChunk({ type: chunk.key ? "key" : "delta", timestamp, data: chunk.data }),
      );
    } catch {
      this.lostPlace();
      this.requestKeyframe(chunk);
    }
  }

  public dispose(): void {
    this.closeDecoder();
  }

  private requestKeyframe(chunk: ServerBrowserVideoChunk): void {
    const now = performance.now();
    if (now - this.lastKeyframeRequest < KEYFRAME_REQUEST_INTERVAL_MS) return;
    this.lastKeyframeRequest = now;
    chunk.requestKeyframe();
  }

  private reset(codec: string): void {
    this.closeDecoder();
    this.codec = codec;
    const decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      // The next delta asks for a keyframe (push sees awaitingKey).
      error: () => this.lostPlace(),
    });
    decoder.configure({ codec, optimizeForLatency: true });
    this.decoder = decoder;
  }

  private lostPlace(): void {
    this.closeDecoder();
    this.awaitingKey = true;
  }

  private draw(frame: VideoFrame): void {
    const { canvas } = this;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    canvas.getContext("2d")?.drawImage(frame, 0, 0);
    const ack = this.acks.get(frame.timestamp);
    this.acks.delete(frame.timestamp);
    frame.close();
    ack?.();
    this.onFrameShown();
  }

  private closeDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder && decoder.state !== "closed") decoder.close();
    for (const ack of this.acks.values()) ack();
    this.acks.clear();
  }
}

/** H.264 Annex B starts with a start code; anything else the daemon sends is VP8. */
function sniffCodec(data: Uint8Array): string {
  const annexB =
    data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
  return annexB ? "avc1.42E028" : "vp8";
}
