import { useEffect, useRef } from "react";
import type { DaemonClient, ServerBrowserFrame } from "@getpaseo/client/internal/daemon-client";

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
): ScreencastViewport {
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

/** Streams a server browser tab while mounted. onFrame must call frame.ack() once shown. */
export function useServerBrowserScreencast(params: {
  client: DaemonClient;
  browserId: string;
  viewport: ScreencastViewport | null;
  onFrame: (frame: ServerBrowserFrame) => void;
}): void {
  const onFrameRef = useRef(params.onFrame);
  onFrameRef.current = params.onFrame;
  const { client, browserId, viewport } = params;
  const maxWidth = viewport?.maxWidth ?? 0;
  const maxHeight = viewport?.maxHeight ?? 0;

  useEffect(() => {
    if (maxWidth <= 0 || maxHeight <= 0) return;
    const subscription = client.observeServerBrowserScreencast(
      { browserId, maxWidth, maxHeight },
      (frame) => onFrameRef.current(frame),
    );
    return () => {
      void subscription.release().catch(() => {});
    };
  }, [browserId, client, maxHeight, maxWidth]);
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
