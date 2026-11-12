import type { ServerBrowserVideoChunk } from "@getpaseo/client/internal/daemon-client";

/** Codecs a viewer asks for, best first. H.264 is Constrained Baseline in Annex B. */
export const H264_CODEC = "avc1.42E028";
export const VP8_CODEC = "vp8";

/** Keyframe requests from a viewer that lost its place, at most this often. */
const KEYFRAME_REQUEST_INTERVAL_MS = 500;
/** This many decoder errors within the window give up on video for this viewer. */
const FATAL_ERRORS = 3;
const FATAL_WINDOW_MS = 10_000;

/** One platform decoder: WebCodecs on web, the PaseoVideo native view on iOS and Android. */
export interface VideoDecoderPort {
  /**
   * Decodes chunk `id`. The port reports the frame through `frameShown(id)` once it is on screen,
   * and any failure through `decoderError()`. A keyframe always comes first after a reset.
   */
  decode(id: number, chunk: ServerBrowserVideoChunk): void;
  /** Drops the decoder's state; the next chunk it gets is a keyframe. */
  reset(): void;
}

/**
 * What every video viewer does with a stream's chunks, whatever decodes them: ack each chunk once
 * its frame is shown (so the daemon's window measures the viewer, not the socket), skip deltas
 * until a keyframe after joining or after an error, ask the daemon for that keyframe, and give up
 * on video when the decoder keeps failing so the surface can ask for JPEG instead.
 */
export class ServerBrowserVideoSession {
  private awaitingKey = true;
  private nextId = 0;
  private lastKeyframeRequest = Number.NEGATIVE_INFINITY;
  private readonly acks = new Map<number, () => void>();
  private errors: number[] = [];
  private requestKeyframeFn: (() => void) | null = null;
  private failed = false;

  public constructor(
    private readonly port: VideoDecoderPort,
    private readonly options: {
      /** The decoder keeps failing: show JPEG instead. Called once. */
      onFatal: () => void;
      now?: () => number;
    },
  ) {}

  public push(chunk: ServerBrowserVideoChunk): void {
    this.requestKeyframeFn = chunk.requestKeyframe;
    if (this.failed || (this.awaitingKey && !chunk.key)) {
      chunk.ack();
      if (!this.failed) this.requestKeyframe();
      return;
    }
    this.awaitingKey = false;
    const id = this.nextId++;
    this.acks.set(id, chunk.ack);
    this.port.decode(id, chunk);
  }

  /** The port put frame `id` on screen; earlier frames it skipped are done too. */
  public frameShown(id: number): void {
    for (const [pending, ack] of this.acks) {
      if (pending > id) break;
      this.acks.delete(pending);
      ack();
    }
  }

  /** The decoder failed: wait for a keyframe, ask for one, and give up after repeated failures. */
  public decoderError(): void {
    if (this.failed) return;
    const now = this.now();
    this.errors = [...this.errors.filter((at) => now - at < FATAL_WINDOW_MS), now];
    if (this.errors.length >= FATAL_ERRORS) {
      this.releaseAcks();
      this.port.reset();
      this.failed = true;
      this.options.onFatal();
      return;
    }
    this.restart();
  }

  /**
   * The platform took the decoder away (the app went to the background, the view got a new
   * surface): start again at a keyframe. The decoder did nothing wrong, so this never counts
   * towards giving up on video.
   */
  public decoderInterrupted(): void {
    if (this.failed) return;
    this.restart();
  }

  public dispose(): void {
    this.releaseAcks();
    this.port.reset();
  }

  private restart(): void {
    this.releaseAcks();
    this.port.reset();
    this.awaitingKey = true;
    this.requestKeyframe();
  }

  private requestKeyframe(): void {
    const now = this.now();
    if (now - this.lastKeyframeRequest < KEYFRAME_REQUEST_INTERVAL_MS) return;
    this.lastKeyframeRequest = now;
    this.requestKeyframeFn?.();
  }

  private releaseAcks(): void {
    for (const ack of this.acks.values()) ack();
    this.acks.clear();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/**
 * The video stream a surface is showing now, if any. The surface creates the player at the first
 * chunk and stops it when video stops (the daemon moved this viewer to JPEG, the stream ended, or
 * the surface turned video off), which releases the platform decoder. `create` returns null when
 * the surface cannot show video now; a chunk that arrives then, such as one in flight when video
 * was turned off, is acked and dropped instead of bringing back a player nothing would stop.
 */
export class ServerBrowserVideoStream<
  Player extends { push(chunk: ServerBrowserVideoChunk): void; dispose(): void },
> {
  private player: Player | null = null;

  public constructor(private readonly create: () => Player | null) {}

  public get current(): Player | null {
    return this.player;
  }

  public push(chunk: ServerBrowserVideoChunk): void {
    this.player ??= this.create();
    if (this.player) this.player.push(chunk);
    else chunk.ack();
  }

  public stop(): void {
    this.player?.dispose();
    this.player = null;
  }
}
