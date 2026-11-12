export interface ScreencastFrame {
  jpeg: Uint8Array;
  /** CSS-pixel size of the page the frame shows, for input mapping. */
  width: number;
  height: number;
}

export interface ScreencastViewerSink {
  send(frame: ScreencastFrame, seq: number): void;
  /** True while the viewer's socket already holds more than it can drain. */
  isCongested(): boolean;
}

export interface ScreencastSize {
  maxWidth: number;
  maxHeight: number;
}

export interface ScreencastSource {
  start(size: ScreencastSize): void;
  stop(): void;
  /** A frame for a joiner while the source has painted none (a suspended tab's last page). */
  stillFrame?: () => ScreencastFrame | null;
}

interface Viewer {
  sink: ScreencastViewerSink;
  size: ScreencastSize;
  /** Send time of every unacked frame, by seq. */
  inFlight: Map<number, number>;
  /** Smallest send-to-ack time seen; queueing only ever adds to it. */
  minRttMs: number | null;
  seq: number;
  mailbox: ScreencastFrame | null;
}

/** The window every viewer starts with, and keeps on a fast link. */
export const SCREENCAST_CREDIT_WINDOW = 2;
export const SCREENCAST_MAX_WINDOW = 8;
/** A viewer's window covers this many frames per second of its round trip. */
const SCREENCAST_TARGET_FPS = 15;
export const SCREENCAST_MAX_DIMENSION = 1600;

/**
 * Fans one tab's CDP screencast out to its viewers.
 *
 * Each viewer may hold a window of unacked frames: SCREENCAST_CREDIT_WINDOW on a fast link, more
 * on a long one, sized from its minimum round trip so a relayed phone at 400 ms still gets about
 * 15 fps instead of 2 frames per round trip. A viewer out of credit keeps only
 * the newest frame (older ones are dropped, never queued) and receives it when it acks. Chromium's
 * own ack is released as soon as any viewer has credit, so a slow phone never throttles a fast
 * desktop, and Chromium stops producing frames only when every viewer is saturated.
 */
export class ScreencastHub {
  private readonly viewers = new Map<string, Viewer>();
  private heldAck: (() => void) | null = null;
  private lastFrame: ScreencastFrame | null = null;
  private runningSize: ScreencastSize | null = null;

  public constructor(
    private readonly source: ScreencastSource,
    private readonly now: () => number = Date.now,
  ) {}

  public get viewerCount(): number {
    return this.viewers.size;
  }

  /** The newest frame while the stream runs. */
  public get currentFrame(): ScreencastFrame | null {
    return this.lastFrame;
  }

  public addViewer(id: string, sink: ScreencastViewerSink, size: ScreencastSize): void {
    const viewer: Viewer = {
      sink,
      size: clampSize(size),
      inFlight: new Map(),
      minRttMs: null,
      seq: 0,
      mailbox: null,
    };
    this.viewers.set(id, viewer);
    // A static page paints nothing new; show the joiner what the others already see.
    const first = this.lastFrame ?? this.source.stillFrame?.() ?? null;
    if (first) this.deliver(viewer, first);
    this.reconcileSource();
  }

  public removeViewer(id: string): void {
    if (!this.viewers.delete(id)) return;
    this.reconcileSource();
    this.releaseHeldAckIfAnyCredit();
  }

  public ack(id: string, seq: number): void {
    const viewer = this.viewers.get(id);
    if (!viewer || seq > viewer.seq) return;
    const sentAt = viewer.inFlight.get(seq);
    if (sentAt === undefined) return;
    viewer.inFlight.delete(seq);
    const rtt = this.now() - sentAt;
    viewer.minRttMs = viewer.minRttMs === null ? rtt : Math.min(viewer.minRttMs, rtt);
    if (viewer.mailbox) {
      const frame = viewer.mailbox;
      viewer.mailbox = null;
      this.deliver(viewer, frame);
    }
    this.releaseHeldAckIfAnyCredit();
  }

  /** Call for every CDP Page.screencastFrame; ackSource acknowledges it to Chromium. */
  public pushFrame(frame: ScreencastFrame, ackSource: () => void): void {
    this.lastFrame = frame;
    for (const viewer of this.viewers.values()) this.deliver(viewer, frame);
    if (this.anyViewerHasCredit()) {
      ackSource();
    } else {
      this.heldAck = ackSource;
    }
  }

  /** The page changed under the stream (navigation, crash): forget the cached frame. */
  public resetLastFrame(): void {
    this.lastFrame = null;
  }

  public close(): void {
    this.viewers.clear();
    this.heldAck = null;
    this.reconcileSource();
  }

  private deliver(viewer: Viewer, frame: ScreencastFrame): void {
    if (!hasCredit(viewer) || viewer.sink.isCongested()) {
      viewer.mailbox = frame;
      return;
    }
    viewer.seq += 1;
    viewer.inFlight.set(viewer.seq, this.now());
    viewer.sink.send(frame, viewer.seq);
  }

  private anyViewerHasCredit(): boolean {
    for (const viewer of this.viewers.values()) if (hasCredit(viewer)) return true;
    return false;
  }

  private releaseHeldAckIfAnyCredit(): void {
    if (!this.heldAck) return;
    if (this.viewers.size > 0 && !this.anyViewerHasCredit()) return;
    const ack = this.heldAck;
    this.heldAck = null;
    ack();
  }

  private reconcileSource(): void {
    if (this.viewers.size === 0) {
      if (this.runningSize) {
        this.runningSize = null;
        this.lastFrame = null;
        this.source.stop();
      }
      return;
    }
    const wanted = largestSize([...this.viewers.values()].map((viewer) => viewer.size));
    if (
      this.runningSize &&
      this.runningSize.maxWidth === wanted.maxWidth &&
      this.runningSize.maxHeight === wanted.maxHeight
    ) {
      return;
    }
    this.runningSize = wanted;
    this.source.start(wanted);
  }
}

export function screencastWindow(minRttMs: number | null): number {
  if (minRttMs === null) return SCREENCAST_CREDIT_WINDOW;
  const frames = Math.ceil((minRttMs * SCREENCAST_TARGET_FPS) / 1000) + 1;
  return Math.max(SCREENCAST_CREDIT_WINDOW, Math.min(SCREENCAST_MAX_WINDOW, frames));
}

function hasCredit(viewer: Viewer): boolean {
  return viewer.inFlight.size < screencastWindow(viewer.minRttMs);
}

function clampSize(size: ScreencastSize): ScreencastSize {
  return {
    maxWidth: clampDimension(size.maxWidth),
    maxHeight: clampDimension(size.maxHeight),
  };
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return SCREENCAST_MAX_DIMENSION;
  return Math.max(64, Math.min(SCREENCAST_MAX_DIMENSION, Math.round(value)));
}

function largestSize(sizes: ScreencastSize[]): ScreencastSize {
  return sizes.reduce(
    (largest, size) => ({
      maxWidth: Math.max(largest.maxWidth, size.maxWidth),
      maxHeight: Math.max(largest.maxHeight, size.maxHeight),
    }),
    { maxWidth: 0, maxHeight: 0 },
  );
}
