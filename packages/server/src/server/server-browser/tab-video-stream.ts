import type { ScreencastSize } from "./screencast-hub.js";
import type { TabVideoCapture } from "./tab-video.js";
import { VideoHub, type VideoViewerSink } from "./video-hub.js";

/** Codecs the daemon offers, best first: H.264 decodes in hardware on every phone. */
const DAEMON_CODECS = ["avc1.42E028", "vp8"];
const VIDEO_FPS = 60;
const MAX_DIMENSION = 1600;

export interface TabVideoViewerSink extends VideoViewerSink {
  /** The capture failed: the viewer goes back to JPEG frames. */
  fallback(): void;
}

/** One tab's video: the capture behind its VideoHub, restarted on resize, torn down with no viewers. */
export class TabVideoStream {
  public readonly hub: VideoHub;
  private codec: string | null = null;
  private streamKey: string | null = null;
  private size: ScreencastSize | null = null;
  private generation = 0;
  private readonly sinks = new Map<string, TabVideoViewerSink>();

  public constructor(
    private readonly params: {
      capture: () => Promise<TabVideoCapture | null>;
      targetId: () => string;
      /** CSS size and device scale of the page. */
      page: () => { width: number; height: number; scale: number };
      /** The hub gained its first viewer (true) or lost its last (false). */
      onWatched: (watched: boolean) => void;
      onError: (message: string) => void;
    },
  ) {
    this.hub = new VideoHub({
      start: (size) => {
        if (!this.size) this.params.onWatched(true);
        this.size = size;
        void this.restart();
      },
      stop: () => {
        this.size = null;
        void this.restart();
        this.params.onWatched(false);
      },
      requestKeyframe: () => void this.requestKeyframe(),
    });
  }

  /** The codec this viewer gets, or null for JPEG. Every viewer of a tab shares one encoder. */
  public async negotiate(viewerCodecs: string[]): Promise<string | null> {
    const capture = await this.params.capture().catch(() => null);
    if (!capture) return null;
    if (this.codec) return viewerCodecs.includes(this.codec) ? this.codec : null;
    const offered = DAEMON_CODECS.filter((codec) => viewerCodecs.includes(codec));
    const picked = await capture.pickCodec(offered, 1280, 800).catch(() => null);
    this.codec = picked;
    return picked;
  }

  public addViewer(id: string, sink: TabVideoViewerSink, size: ScreencastSize): void {
    this.sinks.set(id, sink);
    this.hub.addViewer(id, sink, size);
  }

  public removeViewer(id: string): void {
    this.sinks.delete(id);
    this.hub.removeViewer(id);
  }

  /** The page's size changed, or its target was replaced: capture again. */
  public refresh(): void {
    if (this.size) void this.restart();
  }

  public close(): void {
    this.sinks.clear();
    this.hub.close();
  }

  private async requestKeyframe(): Promise<void> {
    const capture = await this.params.capture().catch(() => null);
    if (capture && this.streamKey) capture.requestKeyframe(this.streamKey);
  }

  private async restart(): Promise<void> {
    const generation = ++this.generation;
    const capture = await this.params.capture().catch(() => null);
    if (!capture || generation !== this.generation) return;
    if (this.streamKey) {
      capture.stop(this.streamKey);
      this.streamKey = null;
    }
    const size = this.size;
    if (!size || !this.codec) return;
    const page = this.params.page();
    const dims = captureSize(page, size);
    try {
      const key = await capture.start(
        { targetId: this.params.targetId(), ...dims, codec: this.codec, fps: VIDEO_FPS },
        {
          onChunk: (chunk) =>
            this.hub.pushChunk({
              key: chunk.key,
              data: chunk.data,
              width: this.params.page().width,
              height: this.params.page().height,
            }),
          onError: (message) => this.fail(message),
        },
      );
      if (generation !== this.generation) {
        capture.stop(key);
        return;
      }
      this.streamKey = key;
      this.hub.resetStream();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private fail(message: string): void {
    this.params.onError(message);
    const sinks = [...this.sinks.entries()];
    for (const [id] of sinks) this.removeViewer(id);
    for (const [, sink] of sinks) sink.fallback();
  }
}

function captureSize(
  page: { width: number; height: number; scale: number },
  size: ScreencastSize,
): { width: number; height: number } {
  const pageWidth = page.width * page.scale;
  const pageHeight = page.height * page.scale;
  const scale = Math.min(
    1,
    Math.min(size.maxWidth, MAX_DIMENSION) / pageWidth,
    Math.min(size.maxHeight, MAX_DIMENSION) / pageHeight,
  );
  return {
    width: Math.max(2, Math.round((pageWidth * scale) / 2) * 2),
    height: Math.max(2, Math.round((pageHeight * scale) / 2) * 2),
  };
}
