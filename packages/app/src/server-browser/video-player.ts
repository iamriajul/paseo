import type { ServerBrowserVideoChunk } from "@getpaseo/client/internal/daemon-client";

/** Codecs the web viewer asks for, best first. H.264 is Constrained Baseline, Annex B. */
export const WEB_VIDEO_CODECS = ["avc1.42E028", "vp8"];

export function webVideoSupported(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
}

/**
 * Decodes a server browser tab's video chunks onto a canvas with WebCodecs. Each chunk is acked
 * when its frame is drawn, so the daemon's window measures the viewer, not just the socket. A
 * decoder error drops everything until the next keyframe.
 */
export class ServerBrowserVideoPlayer {
  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;
  private awaitingKey = true;
  private nextTimestamp = 0;
  private readonly acks = new Map<number, () => void>();

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFrameShown: () => void,
  ) {}

  public push(chunk: ServerBrowserVideoChunk): void {
    if (this.awaitingKey && !chunk.key) {
      chunk.ack();
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
    decoder.decode(
      new EncodedVideoChunk({ type: chunk.key ? "key" : "delta", timestamp, data: chunk.data }),
    );
  }

  public dispose(): void {
    this.closeDecoder();
  }

  private reset(codec: string): void {
    this.closeDecoder();
    this.codec = codec;
    const decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: () => {
        this.closeDecoder();
        this.awaitingKey = true;
      },
    });
    decoder.configure({ codec, optimizeForLatency: true });
    this.decoder = decoder;
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
