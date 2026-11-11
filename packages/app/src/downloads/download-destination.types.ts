export interface DownloadTarget {
  fileName: string;
  mimeType: string;
  /** Exact byte count when known; `null` for a folder's zip. */
  size: number | null;
}

/** Where a streamed download's bytes go as they arrive. */
export interface DownloadSink {
  /** Resolves once the bytes are written, so the caller reads the next slice only then. */
  write(chunk: Uint8Array): Promise<void>;
  /** Finishes the file. Returns a URI to share on native; `null` when the browser owns the file. */
  close(): Promise<string | null>;
  /** Drops the partial file. */
  abort(reason: Error): Promise<void>;
}

/** A save location chosen before the download opens, so a save prompt still has the user's tap. */
export interface DownloadDestination {
  begin(target: DownloadTarget): Promise<DownloadSink>;
  /** Removes whatever choosing the location left behind, when the download never starts. */
  discard(): Promise<void>;
}

/**
 * Returns `null` when the user dismisses the save prompt. Call it synchronously from the tap
 * handler, before any `await`: a browser opens its save prompt only during a user gesture.
 */
export type PrepareDownloadDestination = (
  suggestedName: string,
) => Promise<DownloadDestination | null>;
