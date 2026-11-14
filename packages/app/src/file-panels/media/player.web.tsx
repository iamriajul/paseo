import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { useFileUrl } from "@getpaseo/plugin/client";
import { useTranslation } from "react-i18next";
import { FilePanelLoading } from "../loading";
import { formatFileSize } from "@/utils/format-file-size";
import { useMediaAccess } from "./access";
import type { MediaFormat } from "./formats";
import { MediaMessage } from "./message";
import type { OpenByteRange } from "./range-reader";
import { canStreamMedia, publishMediaStream, type PublishedMediaStream } from "./stream-server.web";
import type { MediaPlayerProps } from "./types";

/**
 * 2 MB in flight streams about 4.6 MB/s at the relay's ~430 ms round trip, ahead of a
 * high-bitrate screen recording; a seek discards at most that. Seeking is bound by round trips
 * (open, first read), not by this: 512 KB x 2 and 1 MB x 3 measured within 0.3 s of each other.
 */
const READ_AHEAD = { sliceBytes: 1024 * 1024, depth: 2 };
/** Without a service worker the file plays from memory, which is fine for clips only. */
const MEMORY_PLAYBACK_MAX_BYTES = 64 * 1024 * 1024;

export function MediaPlayer(props: MediaPlayerProps) {
  const { t } = useTranslation();
  const access = useMediaAccess({ ...props, readAhead: READ_AHEAD });
  if (!canStreamMedia()) {
    if (props.size <= MEMORY_PLAYBACK_MAX_BYTES) return <MemoryPlayer {...props} />;
    return (
      <MediaMessage
        message={t("panels.file.media.needsSecureContext", {
          size: formatFileSize(MEMORY_PLAYBACK_MAX_BYTES),
        })}
      />
    );
  }
  if (access.status === "update-host") {
    return <MediaMessage message={t("panels.file.media.updateHost")} />;
  }
  if (access.status === "unavailable") {
    return <MediaMessage message={t("panels.file.failedToLoadPreview")} tone="error" />;
  }
  return <StreamPlayer {...props} open={access.open} />;
}

type StreamState =
  | { status: "starting" }
  | { status: "published"; stream: PublishedMediaStream }
  | { status: "failed"; message: string };

/**
 * The player element lives in a frame the media service worker controls, so its range requests
 * reach the worker and the worker asks this page for the bytes.
 */
function StreamPlayer({ format, size, label, open }: MediaPlayerProps & { open: OpenByteRange }) {
  const { t } = useTranslation();
  const [state, setState] = useState<StreamState>({ status: "starting" });
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let released = false;
    let published: PublishedMediaStream | null = null;
    async function publish() {
      try {
        const stream = await publishMediaStream({ size, mimeType: format.mimeType, open });
        if (released) {
          stream.release();
          return;
        }
        published = stream;
        setState({ status: "published", stream });
      } catch (error) {
        if (!released) {
          setState({ status: "failed", message: error instanceof Error ? error.message : "" });
        }
      }
    }
    void publish();
    return () => {
      released = true;
      published?.release();
    };
  }, [format.mimeType, open, size]);

  const fail = useCallback((message: string) => setState({ status: "failed", message }), []);
  const stream = state.status === "published" ? state.stream : null;
  const mountElement = useCallback(() => {
    const document = frame.current?.contentDocument;
    if (!document || !stream) return;
    const element = createMediaElement(document, format, label, stream.fileUrl);
    element.addEventListener("error", () => fail(mediaErrorMessage(t, element.error)));
    document.body.replaceChildren(element);
  }, [fail, format, label, stream, t]);

  if (state.status === "failed") {
    return <MediaMessage message={state.message || t("panels.file.media.failed")} tone="error" />;
  }
  if (!stream) return <FilePanelLoading />;
  return (
    <iframe
      key={stream.fileUrl}
      ref={frame}
      title={label}
      data-testid="media-file-preview"
      src={stream.frameUrl}
      // The frame runs no script: this page builds the player in it, which needs the same origin.
      sandbox="allow-same-origin"
      allowFullScreen
      onLoad={mountElement}
      style={frameStyle}
    />
  );
}

/** Plays the file from a whole-file read held in memory. */
function MemoryPlayer({ file, format, label }: MediaPlayerProps) {
  const { t } = useTranslation();
  const url = useFileUrl(file);
  const [error, setError] = useState<string | null>(null);
  if (url.status === "loading") return <FilePanelLoading />;
  if (url.status === "error") return <MediaMessage message={url.error.message} tone="error" />;
  if (error) return <MediaMessage message={error} tone="error" />;
  return (
    <div style={memoryStyle}>
      {createElement(format.kind, {
        src: url.url,
        controls: true,
        playsInline: true,
        preload: "metadata",
        "aria-label": label,
        "data-testid": "media-file-preview",
        style: format.kind === "video" ? videoStyle : audioStyle,
        onError: (event: { currentTarget: HTMLMediaElement }) =>
          setError(mediaErrorMessage(t, event.currentTarget.error)),
      })}
    </div>
  );
}

function createMediaElement(
  document: Document,
  format: MediaFormat,
  label: string,
  src: string,
): HTMLMediaElement {
  const element = document.createElement(format.kind);
  element.controls = true;
  element.preload = "metadata";
  element.setAttribute("playsinline", "");
  element.setAttribute("aria-label", label);
  element.src = src;
  return element;
}

function mediaErrorMessage(t: (key: string) => string, error: MediaError | null): string {
  if (error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)
    return t("panels.file.media.unsupported");
  if (error?.code === MediaError.MEDIA_ERR_DECODE) return t("panels.file.media.unsupported");
  return t("panels.file.media.failed");
}

const frameStyle = { flex: 1, minHeight: 0, width: "100%", border: "none" } as const;
const memoryStyle = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  alignItems: "center",
  justifyContent: "center",
} as const;
const videoStyle = {
  width: "100%",
  height: "100%",
  background: "#000",
  objectFit: "contain",
} as const;
const audioStyle = { width: "calc(100% - 32px)", maxWidth: 560 } as const;
