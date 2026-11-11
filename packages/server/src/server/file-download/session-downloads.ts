import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

/** A client that stops reading (closed tab, lost connection) frees its stream after this. */
const IDLE_TIMEOUT_MS = 60_000;
const MAX_OPEN_DOWNLOADS = 8;
/**
 * A zip's deflate output arrives in ~16 KB pieces. Each frame costs an E2EE record and a relay
 * message, and on web a service-worker pull, so a slice goes out in frames of up to this size.
 */
const FRAME_BYTES = 256 * 1024;

function coalesce(chunks: Buffer[]): Buffer[] {
  const frames: Buffer[] = [];
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pending.length === 0) return;
    frames.push(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes));
    pending = [];
    pendingBytes = 0;
  };
  for (const chunk of chunks) {
    if (pendingBytes + chunk.byteLength > FRAME_BYTES) flush();
    pending.push(chunk);
    pendingBytes += chunk.byteLength;
  }
  flush();
  return frames;
}

export interface SessionDownloadStream {
  fileName: string;
  mimeType: string;
  /** Exact byte count for a file; `null` for a zip, whose size is known only at the end. */
  size: number | null;
  readable: Readable;
  /** Stops the producer behind `readable` (the folder walk). */
  abort: AbortController;
}

interface OpenDownload extends SessionDownloadStream {
  iterator: AsyncIterator<Buffer>;
  /** Bytes pulled from `readable` but not yet handed to a read. */
  leftover: Buffer | null;
  done: boolean;
  /** Reads run one after another: the client pipelines them, the stream is sequential. */
  queue: Promise<unknown>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface DownloadRead {
  chunks: Buffer[];
  bytes: number;
  done: boolean;
}

/**
 * Downloads a session reads over its socket, pulled by the client a slice at a time. The client
 * asks for the next slice only once it has written the last one to disk, so neither end holds
 * more than the slices in flight, however large the file or folder is.
 */
export class SessionDownloads {
  private readonly downloads = new Map<string, OpenDownload>();

  open(stream: SessionDownloadStream): string {
    if (this.downloads.size >= MAX_OPEN_DOWNLOADS) {
      stream.abort.abort();
      stream.readable.destroy();
      throw new Error("Too many downloads in progress.");
    }
    const id = randomUUID();
    const download: OpenDownload = {
      ...stream,
      iterator: (stream.readable as AsyncIterable<Buffer>)[Symbol.asyncIterator](),
      leftover: null,
      done: false,
      queue: Promise.resolve(),
      idleTimer: null,
    };
    // An error before the first read must not surface as an unhandled 'error' event.
    stream.readable.on("error", () => undefined);
    this.downloads.set(id, download);
    this.touch(id, download);
    return id;
  }

  /** Returns up to `maxBytes`; `done` once the stream has ended and every byte has been read. */
  read(id: string, maxBytes: number): Promise<DownloadRead> {
    const download = this.downloads.get(id);
    if (!download) return Promise.reject(new Error("Download not found or expired."));
    const result = download.queue.then(() => this.readSlice(id, download, maxBytes));
    download.queue = result.catch(() => undefined);
    return result;
  }

  close(id: string): void {
    const download = this.downloads.get(id);
    if (!download) return;
    this.downloads.delete(id);
    if (download.idleTimer) clearTimeout(download.idleTimer);
    download.abort.abort();
    download.readable.destroy();
  }

  closeAll(): void {
    for (const id of this.downloads.keys()) this.close(id);
  }

  private async readSlice(id: string, download: OpenDownload, maxBytes: number) {
    if (!this.downloads.has(id)) throw new Error("Download was closed.");
    if (download.idleTimer) clearTimeout(download.idleTimer);
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (bytes < maxBytes) {
        let chunk = download.leftover;
        download.leftover = null;
        if (!chunk) {
          if (download.done) break;
          const next = await download.iterator.next();
          if (next.done) {
            download.done = true;
            break;
          }
          chunk = next.value;
        }
        const room = maxBytes - bytes;
        if (chunk.byteLength > room) {
          download.leftover = chunk.subarray(room);
          chunk = chunk.subarray(0, room);
        }
        chunks.push(chunk);
        bytes += chunk.byteLength;
      }
      // An ended download stays until the client closes it, so reads it pipelined past the
      // end come back empty and done instead of failing; the idle timer is the backstop.
      this.touch(id, download);
      return { chunks: coalesce(chunks), bytes, done: download.done && download.leftover === null };
    } catch (error) {
      this.close(id);
      throw error;
    }
  }

  private touch(id: string, download: OpenDownload): void {
    if (download.idleTimer) clearTimeout(download.idleTimer);
    download.idleTimer = setTimeout(() => this.close(id), IDLE_TIMEOUT_MS);
    download.idleTimer.unref?.();
  }
}
