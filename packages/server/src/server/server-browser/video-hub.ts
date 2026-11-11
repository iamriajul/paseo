import type { ScreencastSize } from "./screencast-hub.js";

export interface VideoChunk {
  key: boolean;
  data: Uint8Array;
  /** CSS-pixel size of the page the chunk shows, for input mapping. */
  width: number;
  height: number;
}

export interface VideoViewerSink {
  send(chunk: VideoChunk, seq: number): void;
  /** True while the viewer's socket already holds more than it can drain. */
  isCongested(): boolean;
}

export interface VideoSource {
  start(size: ScreencastSize): void;
  stop(): void;
  requestKeyframe(): void;
}

interface Viewer {
  sink: VideoViewerSink;
  size: ScreencastSize;
  /** Send time and size of every unacked chunk, by seq. */
  inFlight: Map<number, { sentAt: number; bytes: number }>;
  inFlightBytes: number;
  minRttMs: number | null;
  seq: number;
  /** A delta was dropped (or the viewer just joined): only a keyframe can follow. */
  awaitingKey: boolean;
}

/** Chunks a viewer may hold unacked: a round trip's worth at 60 fps, plus slack. */
const VIDEO_TARGET_FPS = 60;
const VIDEO_MIN_WINDOW = 6;
const VIDEO_MAX_WINDOW = 90;
const VIDEO_MAX_IN_FLIGHT_BYTES = 4 * 1024 * 1024;
/** One keyframe request per this long; a keyframe is 10–30x a delta. */
const KEYFRAME_REQUEST_INTERVAL_MS = 500;

/**
 * Fans one tab's encoded video out to its viewers. One encoder per tab, at the largest size any
 * viewer asked for. Unlike JPEG frames a delta depends on every chunk since the last keyframe, so a
 * viewer out of credit drops deltas and waits for a keyframe, which it asks the encoder for when
 * credit returns. Keyframes are never dropped. A viewer's window is a round trip of 60 fps chunks,
 * so a relayed phone pipelines instead of waiting a round trip per chunk.
 */
export class VideoHub {
  private readonly viewers = new Map<string, Viewer>();
  private runningSize: ScreencastSize | null = null;
  private lastKeyframeRequest = Number.NEGATIVE_INFINITY;
  private keyframeTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly source: VideoSource,
    private readonly now: () => number = Date.now,
  ) {}

  public get viewerCount(): number {
    return this.viewers.size;
  }

  public addViewer(id: string, sink: VideoViewerSink, size: ScreencastSize): void {
    this.viewers.set(id, {
      sink,
      size,
      inFlight: new Map(),
      inFlightBytes: 0,
      minRttMs: null,
      seq: 0,
      awaitingKey: true,
    });
    this.reconcileSource();
    this.requestKeyframe();
  }

  public removeViewer(id: string): void {
    if (!this.viewers.delete(id)) return;
    this.reconcileSource();
  }

  public ack(id: string, seq: number): void {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    const sent = viewer.inFlight.get(seq);
    if (!sent) return;
    viewer.inFlight.delete(seq);
    viewer.inFlightBytes -= sent.bytes;
    const rtt = this.now() - sent.sentAt;
    viewer.minRttMs = viewer.minRttMs === null ? rtt : Math.min(viewer.minRttMs, rtt);
    if (viewer.awaitingKey && hasCredit(viewer)) this.requestKeyframe();
  }

  public pushChunk(chunk: VideoChunk): void {
    for (const viewer of this.viewers.values()) this.deliver(viewer, chunk);
  }

  /** The encoder restarted (resize, navigation of a rebound target): everyone needs a keyframe. */
  public resetStream(): void {
    for (const viewer of this.viewers.values()) viewer.awaitingKey = true;
    this.requestKeyframe();
  }

  public close(): void {
    if (this.keyframeTimer) clearTimeout(this.keyframeTimer);
    this.keyframeTimer = null;
    this.viewers.clear();
    this.reconcileSource();
  }

  private deliver(viewer: Viewer, chunk: VideoChunk): void {
    if (!chunk.key) {
      const canSend = hasCredit(viewer) && !viewer.sink.isCongested();
      if (!canSend) viewer.awaitingKey = true;
      if (viewer.awaitingKey) {
        // A viewer with nothing in flight gets no ack to ask for the keyframe on; ask here.
        if (canSend) this.requestKeyframe();
        return;
      }
    }
    viewer.awaitingKey = false;
    viewer.seq += 1;
    viewer.inFlight.set(viewer.seq, { sentAt: this.now(), bytes: chunk.data.byteLength });
    viewer.inFlightBytes += chunk.data.byteLength;
    viewer.sink.send(chunk, viewer.seq);
  }

  /** Rate-limited; a request inside the interval is deferred to its end, never lost. */
  private requestKeyframe(): void {
    if (!this.runningSize) return;
    const wait = this.lastKeyframeRequest + KEYFRAME_REQUEST_INTERVAL_MS - this.now();
    if (wait > 0) {
      this.keyframeTimer ??= setTimeout(() => {
        this.keyframeTimer = null;
        this.requestKeyframe();
      }, wait);
      return;
    }
    this.lastKeyframeRequest = this.now();
    this.source.requestKeyframe();
  }

  private reconcileSource(): void {
    if (this.viewers.size === 0) {
      if (this.runningSize) {
        this.runningSize = null;
        this.source.stop();
      }
      return;
    }
    const wanted = [...this.viewers.values()].reduce(
      (largest, viewer) => ({
        maxWidth: Math.max(largest.maxWidth, viewer.size.maxWidth),
        maxHeight: Math.max(largest.maxHeight, viewer.size.maxHeight),
      }),
      { maxWidth: 0, maxHeight: 0 },
    );
    if (
      this.runningSize?.maxWidth === wanted.maxWidth &&
      this.runningSize.maxHeight === wanted.maxHeight
    ) {
      return;
    }
    this.runningSize = wanted;
    this.source.start(wanted);
  }
}

export function videoWindow(minRttMs: number | null): number {
  if (minRttMs === null) return VIDEO_MIN_WINDOW;
  const chunks = Math.ceil((minRttMs * VIDEO_TARGET_FPS) / 1000) + 4;
  return Math.max(VIDEO_MIN_WINDOW, Math.min(VIDEO_MAX_WINDOW, chunks));
}

function hasCredit(viewer: Viewer): boolean {
  return (
    viewer.inFlight.size < videoWindow(viewer.minRttMs) &&
    viewer.inFlightBytes < VIDEO_MAX_IN_FLIGHT_BYTES
  );
}
