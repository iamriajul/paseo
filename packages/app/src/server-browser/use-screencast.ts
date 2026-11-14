import { useEffect, useRef } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import type {
  DaemonClient,
  ServerBrowserFrame,
  ServerBrowserVideoChunk,
} from "@getpaseo/client/internal/daemon-client";

export interface ScreencastViewport {
  /** Device pixels the surface can show. */
  maxWidth: number;
  maxHeight: number;
}

// Restarting the stream costs a round trip and a fresh frame; only do it for a real resize.
const RESIZE_THRESHOLD = 0.25;

export function quantizeScreencastViewport(
  previous: ScreencastViewport | null,
  next: ScreencastViewport,
): ScreencastViewport | null {
  // A surface kept mounted behind another tab (display: none) measures 0×0. It has no size: a
  // rounded-up one would be what the tab streams at when it shows again, until its next measure.
  if (next.maxWidth <= 0 || next.maxHeight <= 0) return null;
  if (
    previous &&
    Math.abs(previous.maxWidth - next.maxWidth) / previous.maxWidth < RESIZE_THRESHOLD &&
    Math.abs(previous.maxHeight - next.maxHeight) / previous.maxHeight < RESIZE_THRESHOLD
  ) {
    return previous;
  }
  return {
    maxWidth: Math.max(100, Math.round(next.maxWidth / 50) * 50),
    maxHeight: Math.max(100, Math.round(next.maxHeight / 50) * 50),
  };
}

/**
 * The size to stream at, or null for no stream. A tab kept mounted behind another (a retained
 * panel) must not watch: a watched tab is never suspended, and Chrome would keep painting it for
 * nobody.
 */
export function streamingViewport(
  viewport: ScreencastViewport | null,
  visible: boolean,
): ScreencastViewport | null {
  if (!visible || !viewport || viewport.maxWidth <= 0 || viewport.maxHeight <= 0) return null;
  return viewport;
}

/** Streams a server browser tab while it is on screen. onFrame must call frame.ack() once shown. */
export function useServerBrowserScreencast(params: {
  client: DaemonClient;
  browserId: string;
  viewport: ScreencastViewport | null;
  onFrame: (frame: ServerBrowserFrame) => void;
  /**
   * Ask for video in these codecs; JPEG frames arrive instead when the daemon cannot send video,
   * or moves this viewer to JPEG. `onStop` runs when the stream ends (resize, hidden, unmount):
   * release the decoder there.
   */
  video?: {
    codecs: string[];
    onChunk: (chunk: ServerBrowserVideoChunk) => void;
    onStop: () => void;
  } | null;
}): void {
  const onFrameRef = useRef(params.onFrame);
  onFrameRef.current = params.onFrame;
  const onChunkRef = useRef(params.video?.onChunk);
  onChunkRef.current = params.video?.onChunk;
  const onStopRef = useRef(params.video?.onStop);
  onStopRef.current = params.video?.onStop;
  const videoCodecs = params.video?.codecs.join(",") ?? "";
  const { client, browserId } = params;
  const viewport = streamingViewport(params.viewport, useRetainedPanelActive());
  const maxWidth = viewport?.maxWidth ?? 0;
  const maxHeight = viewport?.maxHeight ?? 0;

  useEffect(() => {
    if (maxWidth <= 0 || maxHeight <= 0) return;
    // A chunk still in flight when this stream ended must not reach the surface: it would start
    // a decoder after onStop released it.
    let live = true;
    const onStop = videoCodecs ? onStopRef.current : undefined;
    const subscription = client.observeServerBrowserScreencast(
      { browserId, maxWidth, maxHeight },
      (frame) => onFrameRef.current(frame),
      videoCodecs
        ? {
            video: {
              codecs: videoCodecs.split(","),
              onChunk: (chunk) => {
                if (live && onChunkRef.current) onChunkRef.current(chunk);
                else chunk.ack();
              },
            },
          }
        : undefined,
    );
    return () => {
      live = false;
      onStop?.();
      void subscription.release().catch(() => {});
    };
  }, [browserId, client, maxHeight, maxWidth, videoCodecs]);
}

/** Maps a point in the surface to page fractions, given the frame is letterboxed ("contain"). */
export function surfacePointToPage(params: {
  x: number;
  y: number;
  surfaceWidth: number;
  surfaceHeight: number;
  pageWidth: number;
  pageHeight: number;
}): { x: number; y: number } | null {
  const { surfaceWidth, surfaceHeight, pageWidth, pageHeight } = params;
  if (surfaceWidth <= 0 || surfaceHeight <= 0 || pageWidth <= 0 || pageHeight <= 0) return null;
  const scale = Math.min(surfaceWidth / pageWidth, surfaceHeight / pageHeight);
  const shownWidth = pageWidth * scale;
  const shownHeight = pageHeight * scale;
  const x = (params.x - (surfaceWidth - shownWidth) / 2) / shownWidth;
  const y = (params.y - (surfaceHeight - shownHeight) / 2) / shownHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** CSS pixels of page per surface pixel, for turning a drag into a scroll delta. */
export function pagePixelsPerSurfacePixel(params: {
  surfaceWidth: number;
  surfaceHeight: number;
  pageWidth: number;
  pageHeight: number;
}): number {
  const scale = Math.min(
    params.surfaceWidth / params.pageWidth,
    params.surfaceHeight / params.pageHeight,
  );
  return scale > 0 ? 1 / scale : 1;
}
