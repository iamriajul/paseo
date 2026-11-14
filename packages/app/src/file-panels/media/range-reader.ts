import type { ByteRange } from "./range";

/** Streams one byte range of the file, a chunk at a time, until the signal aborts. */
export type OpenByteRange = (
  range: ByteRange,
  signal: AbortSignal,
) => Promise<AsyncIterable<Uint8Array>>;

interface OpenRead {
  iterator: AsyncIterator<Uint8Array>;
  abort: AbortController;
}

/**
 * Reads one byte range, opened on the first pull, for a player that pulls only as it plays.
 *
 * A player that stops pulling for a minute loses the read: the daemon drops idle downloads, and
 * the next pull fails. The reader does not reopen it. Chrome and Electron answer the failed
 * response with a new Range request from where they stopped (measured on a 40-minute mp3 whose
 * 819 s of read-ahead left the stream idle), so a reopen here only saved one round trip.
 */
export class RangeReader {
  private position: number;
  private read: OpenRead | null = null;
  private closed = false;

  constructor(
    private readonly open: OpenByteRange,
    private readonly range: ByteRange,
  ) {
    this.position = range.start;
  }

  /** The next chunk, or `null` once the range is read or the reader is closed. */
  async next(): Promise<Uint8Array | null> {
    if (this.closed || this.position > this.range.end) return null;
    try {
      return await this.readChunk();
    } catch (error) {
      this.drop();
      if (this.closed) return null;
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.drop();
  }

  private async readChunk(): Promise<Uint8Array | null> {
    if (!this.read) {
      const abort = new AbortController();
      const stream = await this.open({ start: this.position, end: this.range.end }, abort.signal);
      const iterator = stream[Symbol.asyncIterator]();
      if (this.closed) {
        abort.abort();
        void iterator.return?.().catch(() => undefined);
        return null;
      }
      this.read = { iterator, abort };
    }
    const result = await this.read.iterator.next();
    if (this.closed) return null;
    if (result.done) {
      throw new Error(`The file ended at byte ${this.position} of ${this.range.end + 1}.`);
    }
    const chunk = result.value.subarray(0, this.range.end - this.position + 1);
    this.position += chunk.byteLength;
    if (this.position > this.range.end) this.drop();
    return chunk;
  }

  private drop(): void {
    const read = this.read;
    this.read = null;
    if (!read) return;
    read.abort.abort();
    // Ends the daemon client's generator, whose cleanup closes the daemon's download.
    void read.iterator.return?.().catch(() => undefined);
  }
}
