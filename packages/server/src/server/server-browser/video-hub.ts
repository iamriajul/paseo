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

interface Viewer {
  sink: VideoViewerSink;
  encode: string | undefined;
  /** The encode's frame rate: the window covers a round trip of it. */
  fps: number;
  /** Send time and size of every unacked chunk, by seq. */
  inFlight: Map<number, { sentAt: number; bytes: number }>;
  inFlightBytes: number;
  minRttMs: number | null;
  seq: number;
  /** A delta was dropped (or the viewer just joined an encode): only a keyframe can follow. */
  awaitingKey: boolean;
  /** A delta was dropped since the last keyframe this viewer got. */
  dropping: boolean;
  /** When each recent run of drops started. */
  dropEpisodes: number[];
}

/**
 * Chunks a viewer may hold unacked: a round trip's worth at its encode's rate, plus slack. Acks
 * come after the viewer draws, so a small floor also bounds how much a slow viewer has queued.
 */
const DEFAULT_FPS = 60;
const SLACK = 3;
const MIN_WINDOW = 6;
/** Runs of drops within this long that make a viewer count as falling behind. */
const BEHIND_EPISODES = 2;
const BEHIND_WINDOW_MS = 2000;
const MAX_WINDOW = 90;
const MAX_IN_FLIGHT_BYTES = 4 * 1024 * 1024;

/**
 * Fans a tab's encodes out to its video viewers, each viewer on one encode. A delta depends on
 * every chunk since the last keyframe, so a viewer out of credit drops deltas until a keyframe,
 * and asks its encode for one as soon as it has room. Keyframes are never dropped. A viewer's
 * window is a round trip of 60 fps chunks, so a relayed phone pipelines instead of waiting a
 * round trip per chunk. The encoder rate-limits keyframes itself (pacing.js).
 */
export class VideoHub {
  private readonly viewers = new Map<string, Viewer>();

  public constructor(
    private readonly requestKeyframe: (encode: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  public get viewerCount(): number {
    return this.viewers.size;
  }

  public viewerIds(): string[] {
    return [...this.viewers.keys()];
  }

  public addViewer(id: string, sink: VideoViewerSink): void {
    this.viewers.set(id, {
      sink,
      encode: undefined,
      fps: DEFAULT_FPS,
      inFlight: new Map(),
      inFlightBytes: 0,
      minRttMs: null,
      seq: 0,
      awaitingKey: true,
      dropping: false,
      dropEpisodes: [],
    });
  }

  public removeViewer(id: string): void {
    this.viewers.delete(id);
  }

  /** Moves a viewer to an encode; a new encode starts for it at a keyframe. */
  public assign(id: string, encode: string, fps: number = DEFAULT_FPS): void {
    const viewer = this.viewers.get(id);
    if (!viewer || viewer.encode === encode) return;
    viewer.encode = encode;
    viewer.fps = fps;
    viewer.awaitingKey = true;
    viewer.dropping = false;
    this.requestKeyframe(encode);
  }

  public ack(id: string, seq: number): void {
    const viewer = this.viewers.get(id);
    const sent = viewer?.inFlight.get(seq);
    if (!viewer || !sent) return;
    viewer.inFlight.delete(seq);
    viewer.inFlightBytes -= sent.bytes;
    const rtt = this.now() - sent.sentAt;
    viewer.minRttMs = viewer.minRttMs === null ? rtt : Math.min(viewer.minRttMs, rtt);
    if (viewer.awaitingKey && viewer.encode && hasCredit(viewer)) {
      this.requestKeyframe(viewer.encode);
    }
  }

  /** The viewer's decoder lost its place: deltas wait for the next keyframe. */
  public keyframe(id: string): void {
    const viewer = this.viewers.get(id);
    if (!viewer?.encode) return;
    viewer.awaitingKey = true;
    this.requestKeyframe(viewer.encode);
  }

  /** The stream skipped chunks (a clipped screenshot): every viewer waits for a keyframe. */
  public resync(): void {
    const encodes = new Set<string>();
    for (const viewer of this.viewers.values()) {
      viewer.awaitingKey = true;
      if (viewer.encode) encodes.add(viewer.encode);
    }
    for (const encode of encodes) this.requestKeyframe(encode);
  }

  /**
   * Whether a viewer is falling behind: it started dropping deltas more than once in the last
   * two seconds. One run of drops lasts until the next keyframe (at least 500 ms), so counting it
   * alone would move a viewer down a tier, and back, on every hiccup; each move costs a keyframe.
   */
  public backlogged(id: string): boolean {
    const viewer = this.viewers.get(id);
    if (!viewer) return false;
    const since = this.now() - BEHIND_WINDOW_MS;
    viewer.dropEpisodes = viewer.dropEpisodes.filter((at) => at >= since);
    return viewer.dropEpisodes.length >= BEHIND_EPISODES;
  }

  public publish(encode: string, chunk: VideoChunk): void {
    for (const viewer of this.viewers.values()) {
      if (viewer.encode === encode) this.deliver(viewer, encode, chunk);
    }
  }

  public close(): void {
    this.viewers.clear();
  }

  private deliver(viewer: Viewer, encode: string, chunk: VideoChunk): void {
    if (!chunk.key) {
      const canSend = hasCredit(viewer) && !viewer.sink.isCongested();
      if (!canSend && !viewer.awaitingKey) {
        viewer.awaitingKey = true;
        viewer.dropping = true;
        viewer.dropEpisodes.push(this.now());
      }
      if (viewer.awaitingKey) {
        // A viewer with nothing in flight gets no ack to ask for the keyframe on; ask here.
        if (canSend) this.requestKeyframe(encode);
        return;
      }
    } else {
      viewer.dropping = false;
    }
    viewer.awaitingKey = false;
    viewer.seq += 1;
    viewer.inFlight.set(viewer.seq, { sentAt: this.now(), bytes: chunk.data.byteLength });
    viewer.inFlightBytes += chunk.data.byteLength;
    viewer.sink.send(chunk, viewer.seq);
  }
}

export function videoWindow(minRttMs: number | null, fps: number = DEFAULT_FPS): number {
  if (minRttMs === null) return MIN_WINDOW;
  const chunks = Math.ceil((minRttMs * fps) / 1000) + SLACK;
  return Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, chunks));
}

function hasCredit(viewer: Viewer): boolean {
  return (
    viewer.inFlight.size < videoWindow(viewer.minRttMs, viewer.fps) &&
    viewer.inFlightBytes < MAX_IN_FLIGHT_BYTES
  );
}
