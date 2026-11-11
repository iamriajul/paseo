import { i18n } from "@/i18n/i18next";
import { DownloadCancelledError } from "@/downloads/download-cancelled-error";
import type { DownloadDestination, DownloadSink } from "@/downloads/download-destination.types";

/** What the daemon client's `openDownloadStream` returns. */
export interface SessionDownloadStream {
  fileName: string;
  mimeType: string;
  size: number | null;
  chunks: AsyncIterable<Uint8Array>;
}

export interface SessionDownloadProgress {
  bytesWritten: number;
  /** `null` for a folder's zip, whose size is known only at the end. */
  totalBytes: number | null;
  /** Bytes per second since the download started. */
  speed: number;
}

export interface RunSessionDownloadParams {
  /** Prepared by the caller before its first `await`; resolves `null` if the user said no. */
  destination: Promise<DownloadDestination | null>;
  open: (signal: AbortSignal) => Promise<SessionDownloadStream>;
  signal: AbortSignal;
  onStart: (stream: SessionDownloadStream) => void;
  onProgress: (progress: SessionDownloadProgress) => void;
  now?: () => number;
}

export type SessionDownloadResult =
  | { status: "complete"; fileName: string; mimeType: string; uri: string | null }
  | { status: "cancelled" };

const PROGRESS_INTERVAL_MS = 250;

/**
 * Pipes a download read over the session socket into its destination one slice at a time: the
 * next slice is requested only once the last is written, so memory stays flat however large
 * the download is. Cancelling or failing drops the partial file and closes the daemon's stream.
 */
export async function runSessionDownload({
  destination: pendingDestination,
  open,
  signal,
  onStart,
  onProgress,
  now = Date.now,
}: RunSessionDownloadParams): Promise<SessionDownloadResult> {
  const destination = await pendingDestination;
  if (!destination) return { status: "cancelled" };
  if (signal.aborted) {
    await destination.discard();
    return { status: "cancelled" };
  }

  let stream: SessionDownloadStream;
  try {
    stream = await open(signal);
  } catch (error) {
    await destination.discard();
    if (signal.aborted) return { status: "cancelled" };
    throw error;
  }
  onStart(stream);

  let sink: DownloadSink | null = null;
  try {
    sink = await destination.begin({
      fileName: stream.fileName,
      mimeType: stream.mimeType,
      size: stream.size,
    });
    const startedAt = now();
    let bytesWritten = 0;
    let reportedAt = 0;
    for await (const chunk of stream.chunks) {
      await sink.write(chunk);
      bytesWritten += chunk.byteLength;
      const time = now();
      if (time - reportedAt >= PROGRESS_INTERVAL_MS) {
        reportedAt = time;
        const elapsed = (time - startedAt) / 1000;
        onProgress({
          bytesWritten,
          totalBytes: stream.size,
          speed: elapsed > 0 ? bytesWritten / elapsed : 0,
        });
      }
    }
    const uri = await sink.close();
    return { status: "complete", fileName: stream.fileName, mimeType: stream.mimeType, uri };
  } catch (error) {
    const cancelled = signal.aborted || error instanceof DownloadCancelledError;
    let reason: Error;
    if (cancelled) reason = new DownloadCancelledError();
    else reason = error instanceof Error ? error : new Error(i18n.t("downloads.failed"));
    if (sink) await sink.abort(reason).catch(() => undefined);
    else await destination.discard();
    if (cancelled) return { status: "cancelled" };
    throw reason;
  }
}
