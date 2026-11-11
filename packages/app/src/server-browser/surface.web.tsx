import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type {
  DaemonClient,
  ServerBrowserFrame,
  ServerBrowserVideoChunk,
} from "@getpaseo/client/internal/daemon-client";
import type { ServerBrowserInputEvent } from "@getpaseo/protocol/server-browser/rpc-schemas";
import { InputBatcher, keyboardEventToInput, modifiersOf, mouseButtonOf } from "./input";
import {
  quantizeScreencastViewport,
  surfacePointToPage,
  useServerBrowserScreencast,
  type ScreencastViewport,
} from "./use-screencast";
import { ServerBrowserVideoPlayer, WEB_VIDEO_CODECS, webVideoSupported } from "./video-player";

export interface ServerBrowserSurfaceHandle {
  focusKeyboard(): void;
}

interface ServerBrowserSurfaceProps {
  client: DaemonClient;
  browserId: string;
  pageWidth: number;
  pageHeight: number;
  /** Annotate element is picking: pointing highlights, a click or tap picks, other input stops. */
  annotating?: boolean;
  onCancelAnnotate?: () => void;
  /** The surface's size in CSS pixels, each time it changes; the Responsive device size follows it. */
  onSize?: (size: { width: number; height: number }) => void;
  /** The host streams video (features.serverBrowserVideo); JPEG otherwise. */
  video?: boolean;
}

interface ProbeGlobal {
  /** Measurement hook (scripts/server-browser-video-bench): called with the element just painted. */
  __paseoServerBrowserProbe?: (element: HTMLCanvasElement | HTMLImageElement) => void;
}

function probe(element: HTMLCanvasElement | HTMLImageElement): void {
  (globalThis as ProbeGlobal).__paseoServerBrowserProbe?.(element);
}

// Web and Electron: the frame is an <img>, input is DOM events on a focusable wrapper.
export const ServerBrowserSurface = forwardRef<
  ServerBrowserSurfaceHandle,
  ServerBrowserSurfaceProps
>(function ServerBrowserSurface(
  {
    client,
    browserId,
    pageWidth,
    pageHeight,
    annotating = false,
    onCancelAnnotate,
    onSize,
    video = false,
  },
  ref,
) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [viewport, setViewport] = useState<ScreencastViewport | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<ServerBrowserVideoPlayer | null>(null);
  // Which element shows the page: the last stream to paint wins (video, or JPEG as fallback).
  const [shown, setShown] = useState<"jpeg" | "video">("jpeg");
  // The decoder kept failing on this tab: watch it as JPEG instead.
  const [videoFailedFor, setVideoFailedFor] = useState<string | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const pageSizeRef = useRef({ width: pageWidth, height: pageHeight });
  pageSizeRef.current = { width: pageWidth, height: pageHeight };
  const annotatingRef = useRef(annotating);
  annotatingRef.current = annotating;
  const onCancelAnnotateRef = useRef(onCancelAnnotate);
  onCancelAnnotateRef.current = onCancelAnnotate;
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;

  // Escape must reach the surface without a click first, and a click there would pick.
  useEffect(() => {
    if (annotating) wrapperRef.current?.focus();
  }, [annotating]);

  const batcherRef = useRef<InputBatcher | null>(null);
  if (!batcherRef.current) {
    batcherRef.current = new InputBatcher((events) =>
      client
        .serverBrowserInput(browserId, events)
        .catch((error: unknown) => console.warn("[server-browser] input failed", error)),
    );
  }
  const send = useCallback((event: ServerBrowserInputEvent, flush: boolean) => {
    batcherRef.current?.push(event, flush);
  }, []);

  useImperativeHandle(ref, () => ({ focusKeyboard: () => wrapperRef.current?.focus() }), []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver(() => {
      const rect = wrapper.getBoundingClientRect();
      onSizeRef.current?.({ width: rect.width, height: rect.height });
      const ratio = window.devicePixelRatio || 1;
      setViewport((previous) =>
        quantizeScreencastViewport(previous, {
          maxWidth: rect.width * ratio,
          maxHeight: rect.height * ratio,
        }),
      );
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  const handleFrame = useCallback((frame: ServerBrowserFrame) => {
    const image = imageRef.current;
    if (!image) {
      frame.ack();
      return;
    }
    const url = URL.createObjectURL(new Blob([frame.jpeg as BlobPart], { type: "image/jpeg" }));
    const onLoad = () => {
      image.removeEventListener("error", onError);
      const previous = objectUrlRef.current;
      objectUrlRef.current = url;
      if (previous) URL.revokeObjectURL(previous);
      setHasFrame(true);
      if (shownRef.current !== "jpeg") setShown("jpeg");
      probe(image);
      frame.ack();
    };
    const onError = () => {
      image.removeEventListener("load", onLoad);
      URL.revokeObjectURL(url);
      frame.ack();
    };
    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });
    image.src = url;
  }, []);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      batcherRef.current?.dispose();
    },
    [],
  );

  const handleChunk = useCallback(
    (chunk: ServerBrowserVideoChunk) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        chunk.ack();
        return;
      }
      if (!playerRef.current) {
        playerRef.current = new ServerBrowserVideoPlayer(
          canvas,
          () => {
            if (shownRef.current !== "video") setShown("video");
            setHasFrame(true);
            probe(canvas);
          },
          () => setVideoFailedFor(browserId),
        );
      }
      playerRef.current.push(chunk);
    },
    [browserId],
  );

  useEffect(
    () => () => {
      playerRef.current?.dispose();
      playerRef.current = null;
    },
    [browserId],
  );

  const videoEnabled = video && webVideoSupported() && videoFailedFor !== browserId;
  useEffect(() => {
    if (videoEnabled) return;
    playerRef.current?.dispose();
    playerRef.current = null;
  }, [videoEnabled]);
  useServerBrowserScreencast({
    client,
    browserId,
    viewport,
    onFrame: handleFrame,
    video: videoEnabled ? { codecs: WEB_VIDEO_CODECS, onChunk: handleChunk } : null,
  });

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const toPage = (event: { clientX: number; clientY: number }) => {
      const rect = wrapper.getBoundingClientRect();
      return surfacePointToPage({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        surfaceWidth: rect.width,
        surfaceHeight: rect.height,
        pageWidth: pageSizeRef.current.width,
        pageHeight: pageSizeRef.current.height,
      });
    };
    let pressedButton: "left" | "right" | "middle" | null = null;
    let clickCount = 0;
    let lastDownAt = 0;
    // Annotating: the press only points (a finger drag moves the highlight instead of scrolling),
    // and the release picks with one click at the release point.
    let annotatePress = false;
    const pointAt = (point: { x: number; y: number }, flush: boolean) =>
      send({ kind: "mouse", action: "move", ...point, button: "none", clickCount: 0 }, flush);
    const onPointerDown = (event: PointerEvent) => {
      const point = toPage(event);
      wrapper.focus();
      if (!point) return;
      event.preventDefault();
      wrapper.setPointerCapture(event.pointerId);
      if (annotatingRef.current) {
        annotatePress = event.button === 0;
        pointAt(point, true);
        return;
      }
      pressedButton = mouseButtonOf(event.button);
      clickCount = event.timeStamp - lastDownAt < 400 ? Math.min(3, clickCount + 1) : 1;
      lastDownAt = event.timeStamp;
      send(
        {
          kind: "mouse",
          action: "down",
          ...point,
          button: pressedButton,
          clickCount,
          modifiers: modifiersOf(event),
        },
        true,
      );
    };
    const onPointerMove = (event: PointerEvent) => {
      const point = toPage(event);
      if (!point) return;
      if (annotatingRef.current) {
        pointAt(point, false);
        return;
      }
      send(
        {
          kind: "mouse",
          action: "move",
          ...point,
          button: pressedButton ?? "none",
          clickCount: 0,
          modifiers: modifiersOf(event),
        },
        false,
      );
    };
    const onPointerUp = (event: PointerEvent) => {
      const point = toPage(event);
      if (annotatePress) {
        annotatePress = false;
        if (!point || !annotatingRef.current) return;
        pointAt(point, false);
        send({ kind: "mouse", action: "down", ...point, button: "left", clickCount: 1 }, false);
        send({ kind: "mouse", action: "up", ...point, button: "left", clickCount: 1 }, true);
        return;
      }
      if (!pressedButton) return;
      send(
        {
          kind: "mouse",
          action: "up",
          ...(point ?? { x: 0, y: 0 }),
          button: pressedButton,
          clickCount,
          modifiers: modifiersOf(event),
        },
        true,
      );
      pressedButton = null;
    };
    const onWheel = (event: WheelEvent) => {
      const point = toPage(event);
      if (!point) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : 1;
      send(
        {
          kind: "wheel",
          ...point,
          deltaX: event.deltaX * scale,
          deltaY: event.deltaY * scale,
        },
        false,
      );
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (annotatePress) {
        annotatePress = false;
        return;
      }
      onPointerUp(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (annotatingRef.current) {
        event.preventDefault();
        if (event.key === "Escape") onCancelAnnotateRef.current?.();
        return;
      }
      const isPaste = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
      if (isPaste) return;
      event.preventDefault();
      for (const input of keyboardEventToInput(event, "down")) send(input, true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      if (annotatingRef.current) return;
      for (const input of keyboardEventToInput(event, "up")) send(input, true);
    };
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text || annotatingRef.current) return;
      event.preventDefault();
      send({ kind: "text", text }, true);
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    wrapper.addEventListener("pointerdown", onPointerDown);
    wrapper.addEventListener("pointermove", onPointerMove);
    wrapper.addEventListener("pointerup", onPointerUp);
    wrapper.addEventListener("pointercancel", onPointerCancel);
    wrapper.addEventListener("wheel", onWheel, { passive: false });
    wrapper.addEventListener("keydown", onKeyDown);
    wrapper.addEventListener("keyup", onKeyUp);
    wrapper.addEventListener("paste", onPaste);
    wrapper.addEventListener("contextmenu", onContextMenu);
    return () => {
      wrapper.removeEventListener("pointerdown", onPointerDown);
      wrapper.removeEventListener("pointermove", onPointerMove);
      wrapper.removeEventListener("pointerup", onPointerUp);
      wrapper.removeEventListener("pointercancel", onPointerCancel);
      wrapper.removeEventListener("wheel", onWheel);
      wrapper.removeEventListener("keydown", onKeyDown);
      wrapper.removeEventListener("keyup", onKeyUp);
      wrapper.removeEventListener("paste", onPaste);
      wrapper.removeEventListener("contextmenu", onContextMenu);
    };
  }, [send]);

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      data-testid="server-browser-surface"
      data-annotating={annotating ? "true" : undefined}
      style={annotating ? ANNOTATING_WRAPPER_STYLE : WRAPPER_STYLE}
    >
      <img
        ref={imageRef}
        alt=""
        draggable={false}
        style={hasFrame && shown === "jpeg" ? IMAGE_STYLE : HIDDEN_IMAGE_STYLE}
      />
      <canvas
        ref={canvasRef}
        style={hasFrame && shown === "video" ? IMAGE_STYLE : HIDDEN_IMAGE_STYLE}
      />
      {hasFrame ? null : <div style={PLACEHOLDER_STYLE}>Connecting to the server browser…</div>}
    </div>
  );
});

const WRAPPER_STYLE = {
  flex: 1,
  minHeight: 0,
  position: "relative",
  outline: "none",
  touchAction: "none",
  backgroundColor: "#111",
  overflow: "hidden",
  cursor: "default",
} as const;

const ANNOTATING_WRAPPER_STYLE = { ...WRAPPER_STYLE, cursor: "crosshair" } as const;

const IMAGE_STYLE = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "contain",
  userSelect: "none",
  pointerEvents: "none",
} as const;

const HIDDEN_IMAGE_STYLE = { ...IMAGE_STYLE, visibility: "hidden" } as const;

const PLACEHOLDER_STYLE = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#999",
  font: "13px system-ui, sans-serif",
} as const;
