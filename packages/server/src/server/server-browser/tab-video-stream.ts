import type { TabVideoCapture } from "./tab-video.js";
import { VideoHub, type VideoViewerSink } from "./video-hub.js";
import {
  CAPTURE_FPS,
  planVideo,
  VideoPressure,
  type VideoEncode,
  type VideoPlanSource,
} from "./video-plan.js";

/** Codecs the daemon offers, best first: Constrained Baseline H.264 decodes in hardware on every phone. */
export const DAEMON_VIDEO_CODECS = ["avc1.42E028", "vp8"];
/** How often each viewer's load is sampled. */
const PRESSURE_SAMPLE_MS = 250;
/** After the encodes change, viewers settle this long before their load counts again. */
const PLAN_SETTLE_MS = 2000;
/** One keyframe request per encode per this long reaches the extension. */
const KEYFRAME_REQUEST_MS = 200;

export interface TabVideoViewerSink extends VideoViewerSink {
  /** Video stopped for this viewer (the capture failed): it goes back to JPEG frames. */
  fallback(): void;
}

interface StreamViewer {
  sink: TabVideoViewerSink;
  maxWidth: number;
  maxHeight: number;
  codec: string;
  pressure: VideoPressure;
}

interface RunningCapture {
  id: string;
  width: number;
  height: number;
}

let nextCaptureId = 1;

/**
 * One tab's video: the capture and encodes behind its VideoHub. The capture runs at the largest
 * picture any encode needs, each encode is one viewer tier (video-plan.ts), and the whole thing
 * stops with its last viewer. A clipped or full-page screenshot resizes the page's view for a
 * moment, so the tab suspends video around one and viewers resume at a keyframe.
 */
export class TabVideoStream {
  public readonly hub: VideoHub;
  private readonly viewers = new Map<string, StreamViewer>();
  private capture: RunningCapture | null = null;
  /** The browser's capture, once known: stopping must reach it before the next start does. */
  private captureApi: TabVideoCapture | null = null;
  private encodes: VideoEncode[] = [];
  private generation = 0;
  private suspended = 0;
  private sampler: ReturnType<typeof setInterval> | null = null;
  private readonly lastKeyframeRequest = new Map<string, number>();
  private planChangedAt = Number.NEGATIVE_INFINITY;

  public constructor(
    private readonly params: {
      capture: () => Promise<TabVideoCapture | null>;
      targetId: () => string;
      page: () => VideoPlanSource;
      /** The stream gained its first viewer (true) or lost its last (false). */
      onWatched: (watched: boolean) => void;
      onError: (message: string) => void;
      /** The encodes changed (a viewer joined, left or changed tier); for the log. */
      onPlan?: (encodes: string[]) => void;
      now?: () => number;
    },
  ) {
    this.hub = new VideoHub((encode) => this.requestKeyframe(encode), params.now);
  }

  private get now(): number {
    return (this.params.now ?? Date.now)();
  }

  /** The codec this viewer gets, or null for JPEG (no capture on this engine, or no common codec). */
  public async negotiate(viewerCodecs: string[]): Promise<string | null> {
    const capture = await this.params.capture().catch(() => null);
    if (!capture) return null;
    const supported = await capture.supported(DAEMON_VIDEO_CODECS).catch((): string[] => []);
    return viewerCodecs.find((codec) => supported.includes(codec)) ?? null;
  }

  public addViewer(
    id: string,
    sink: TabVideoViewerSink,
    box: { maxWidth: number; maxHeight: number; codec: string },
  ): void {
    const first = this.viewers.size === 0;
    this.viewers.set(id, { sink, ...box, pressure: new VideoPressure() });
    this.hub.addViewer(id, sink);
    if (first) {
      this.params.onWatched(true);
      this.sampler = setInterval(() => this.samplePressure(), PRESSURE_SAMPLE_MS);
      this.sampler.unref?.();
    }
    void this.replan();
  }

  public removeViewer(id: string): void {
    if (!this.viewers.delete(id)) return;
    this.hub.removeViewer(id);
    if (this.viewers.size === 0) {
      if (this.sampler) clearInterval(this.sampler);
      this.sampler = null;
      this.params.onWatched(false);
    }
    void this.replan();
  }

  /** The viewer's decoder lost its place. */
  public viewerKeyframe(id: string): void {
    this.hub.keyframe(id);
  }

  /** The page's size changed, or its target was replaced: capture again. */
  public refresh(): void {
    if (this.capture) this.stopCapture();
    void this.replan();
  }

  /** Runs `action` with video paused; viewers resume at a keyframe. */
  public async suspendDuring<T>(action: () => Promise<T>): Promise<T> {
    if (this.viewers.size === 0) return action();
    this.suspended += 1;
    try {
      return await action();
    } finally {
      this.suspended -= 1;
      if (this.suspended === 0) this.hub.resync();
    }
  }

  public close(): void {
    for (const id of this.viewers.keys()) this.removeViewer(id);
    this.hub.close();
  }

  private samplePressure(): void {
    // A new encode starts every viewer on it at a keyframe; its drops say nothing about the link.
    if (this.now - this.planChangedAt < PLAN_SETTLE_MS) return;
    let changed = false;
    for (const [id, viewer] of this.viewers) {
      const before = viewer.pressure.load;
      if (viewer.pressure.sample(this.hub.backlogged(id), this.now) !== before) changed = true;
    }
    if (changed) void this.replan();
  }

  private async replan(): Promise<void> {
    const generation = ++this.generation;
    if (this.viewers.size === 0) {
      this.stopCapture();
      return;
    }
    const capture = await this.params.capture().catch(() => null);
    if (generation !== this.generation) return;
    this.captureApi = capture;
    if (!capture) {
      this.fail("The tab video capture is not available");
      return;
    }
    const plan = planVideo(
      this.params.page(),
      [...this.viewers].map(([id, viewer]) => ({
        id,
        maxWidth: viewer.maxWidth,
        maxHeight: viewer.maxHeight,
        codec: viewer.codec,
        load: viewer.pressure.load,
      })),
    );
    const width = Math.max(...plan.encodes.map((encode) => encode.width));
    const height = Math.max(...plan.encodes.map((encode) => encode.height));
    if (!this.capture || this.capture.width !== width || this.capture.height !== height) {
      this.stopCapture();
      const running: RunningCapture = { id: `c${nextCaptureId++}`, width, height };
      try {
        await capture.start({
          id: running.id,
          targetId: this.params.targetId(),
          width,
          height,
          fps: CAPTURE_FPS,
          listener: {
            onChunk: (encode, chunk) => {
              if (this.suspended > 0 || this.capture?.id !== running.id) return;
              const page = this.params.page();
              this.hub.publish(encode, { ...chunk, width: page.width, height: page.height });
            },
            onEncodeFailed: (encode, reason) => {
              if (this.capture?.id === running.id) this.failEncode(encode, reason);
            },
            onEnded: (reason) => {
              if (this.capture?.id !== running.id) return;
              this.capture = null;
              this.fail(reason);
            },
          },
        });
      } catch (error) {
        if (generation === this.generation) {
          this.fail(error instanceof Error ? error.message : String(error));
        } else {
          capture.stop(running.id);
        }
        return;
      }
      if (generation !== this.generation) {
        capture.stop(running.id);
        return;
      }
      this.capture = running;
      this.encodes = [];
    }
    const keys = plan.encodes.map((encode) => encode.key).join("|");
    if (keys !== this.encodes.map((encode) => encode.key).join("|")) {
      this.encodes = plan.encodes;
      capture.setEncodes(this.capture.id, plan.encodes);
      this.params.onPlan?.(plan.encodes.map((encode) => encode.key));
      this.planChangedAt = this.now;
    }
    for (const [id, key] of plan.viewers) {
      this.hub.assign(id, key, plan.encodes.find((encode) => encode.key === key)?.fps);
    }
  }

  private requestKeyframe(encode: string): void {
    const running = this.capture;
    if (!running) return;
    const last = this.lastKeyframeRequest.get(encode) ?? Number.NEGATIVE_INFINITY;
    if (this.now - last < KEYFRAME_REQUEST_MS) return;
    this.lastKeyframeRequest.set(encode, this.now);
    void this.params.capture().then((capture) => capture?.requestKeyframe(running.id, encode));
  }

  private stopCapture(): void {
    const running = this.capture;
    this.capture = null;
    this.encodes = [];
    this.lastKeyframeRequest.clear();
    // Synchronously: a start queued after this must find the tab free, or Chrome refuses it
    // ("Cannot capture a tab with an active stream").
    if (running) this.captureApi?.stop(running.id);
  }

  /** Viewers of one encode go back to JPEG; the others keep video. */
  private failEncode(encode: string, reason: string): void {
    this.params.onError(reason);
    const failed = this.encodes.find((candidate) => candidate.key === encode);
    for (const [id, viewer] of this.viewers) {
      if (!failed || viewer.codec === failed.codec) this.moveToJpeg(id, viewer);
    }
  }

  private fail(reason: string): void {
    this.params.onError(reason);
    for (const [id, viewer] of this.viewers) this.moveToJpeg(id, viewer);
  }

  private moveToJpeg(id: string, viewer: StreamViewer): void {
    this.removeViewer(id);
    viewer.sink.fallback();
  }
}
