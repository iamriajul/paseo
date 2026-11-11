import type { ServerBrowserVideoChunk } from "@getpaseo/client/internal/daemon-client";
import {
  H264_CODEC,
  ServerBrowserVideoSession,
  VP8_CODEC,
  type VideoDecoderPort,
} from "./video-session";

/** Codecs the web viewer asks for, best first. */
export const WEB_VIDEO_CODECS = [H264_CODEC, VP8_CODEC];

export function webVideoSupported(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
}

/** Decodes a server browser tab's video chunks onto a canvas with WebCodecs. */
export class ServerBrowserVideoPlayer {
  private readonly session: ServerBrowserVideoSession;
  private readonly port: WebCodecsPort;

  public constructor(
    canvas: HTMLCanvasElement,
    onFrameShown: () => void,
    /** The decoder keeps failing: the surface asks for JPEG instead. */
    onFatal: () => void,
  ) {
    this.port = new WebCodecsPort(
      canvas,
      (id) => {
        this.session.frameShown(id);
        onFrameShown();
      },
      () => this.session.decoderError(),
    );
    this.session = new ServerBrowserVideoSession(this.port, { onFatal });
  }

  public push(chunk: ServerBrowserVideoChunk): void {
    this.session.push(chunk);
  }

  public dispose(): void {
    this.session.dispose();
  }
}

class WebCodecsPort implements VideoDecoderPort {
  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onShown: (id: number) => void,
    private readonly onError: () => void,
  ) {}

  public decode(id: number, chunk: ServerBrowserVideoChunk): void {
    if (chunk.key) {
      const codec = sniffCodec(chunk.data);
      if (!this.decoder || this.decoder.state === "closed" || codec !== this.codec) {
        this.open(codec);
      }
    }
    const decoder = this.decoder;
    if (!decoder) {
      this.onError();
      return;
    }
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: chunk.key ? "key" : "delta",
          timestamp: id,
          data: chunk.data,
        }),
      );
    } catch {
      this.onError();
    }
  }

  public reset(): void {
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder && decoder.state !== "closed") decoder.close();
  }

  private open(codec: string): void {
    this.reset();
    this.codec = codec;
    const decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: () => this.onError(),
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
    const id = frame.timestamp;
    frame.close();
    this.onShown(id);
  }
}

/** H.264 Annex B starts with a start code; anything else the daemon sends is VP8. */
function sniffCodec(data: Uint8Array): string {
  const annexB =
    data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
  return annexB ? H264_CODEC : VP8_CODEC;
}
