import { filePanelExtension } from "../resolve";

export type MediaKind = "video" | "audio";

export interface MediaFormat {
  kind: MediaKind;
  /** Sent as Content-Type to the player; the daemon labels most of these octet-stream. */
  mimeType: string;
}

/**
 * The files the media panel plays. Whether one plays depends on the platform's decoders: iOS has
 * no WebM, Matroska or Ogg, and the player shows its error for those.
 */
const MEDIA_FORMATS = {
  mp4: { kind: "video", mimeType: "video/mp4" },
  m4v: { kind: "video", mimeType: "video/mp4" },
  mov: { kind: "video", mimeType: "video/quicktime" },
  webm: { kind: "video", mimeType: "video/webm" },
  mkv: { kind: "video", mimeType: "video/x-matroska" },
  ogv: { kind: "video", mimeType: "video/ogg" },
  mp3: { kind: "audio", mimeType: "audio/mpeg" },
  m4a: { kind: "audio", mimeType: "audio/mp4" },
  aac: { kind: "audio", mimeType: "audio/aac" },
  wav: { kind: "audio", mimeType: "audio/wav" },
  flac: { kind: "audio", mimeType: "audio/flac" },
  ogg: { kind: "audio", mimeType: "audio/ogg" },
  oga: { kind: "audio", mimeType: "audio/ogg" },
  opus: { kind: "audio", mimeType: "audio/ogg" },
  weba: { kind: "audio", mimeType: "audio/webm" },
} as const satisfies Record<string, MediaFormat>;

export const MEDIA_EXTENSIONS = Object.keys(MEDIA_FORMATS) as (keyof typeof MEDIA_FORMATS)[];

export function mediaFormat(path: string): MediaFormat | null {
  const extension = filePanelExtension(path);
  return Object.hasOwn(MEDIA_FORMATS, extension)
    ? MEDIA_FORMATS[extension as keyof typeof MEDIA_FORMATS]
    : null;
}
