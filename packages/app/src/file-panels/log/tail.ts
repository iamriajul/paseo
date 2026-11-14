import { decodeUtf8 } from "@/utils/decode-utf8";

/** Reads `length` bytes of the file from `offset`. */
export type ReadBytes = (offset: number, length: number) => Promise<Uint8Array>;

/** How much of the file each open or "Load earlier" reads. */
export const TAIL_CHUNK_BYTES = 256 * 1024;
/** Lines kept while following; the oldest go first, and "Load earlier" reads them again. */
export const MAX_TAIL_LINES = 50_000;

export interface LogTailSnapshot {
  status: "loading" | "ready" | "failed";
  lines: readonly string[];
  /** Where the first line starts in the file; 0 once the start of the file is shown. */
  start: number;
  error: string | null;
}

const NEWLINE = 0x0a;

/**
 * The end of a growing text file, as lines: it reads the last chunk, then each time the file
 * grows, only the bytes past what it read, and earlier chunks on request. A file that shrinks was
 * truncated or rotated, so the tail starts over. Reads run one at a time; sizes reported during a
 * read collapse into one read after it.
 */
export class LogTail {
  private lines: string[] = [];
  /** The last line has no newline yet; the next bytes continue it. */
  private open = false;
  private start = 0;
  private end = 0;
  /** The start of a character the last read cut off, prepended to the next read. */
  private carry = new Uint8Array(0);
  private snapshot: LogTailSnapshot = { status: "loading", lines: [], start: 0, error: null };
  private readonly listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private requestedSize = 0;
  private syncing = false;
  private disposed = false;

  constructor(
    private readonly read: ReadBytes,
    private readonly chunkBytes = TAIL_CHUNK_BYTES,
    private readonly maxLines = MAX_TAIL_LINES,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LogTailSnapshot => this.snapshot;

  /** The file's size now; reads what changed since the last read. */
  sync(size: number): Promise<void> {
    this.requestedSize = size;
    if (this.syncing) return this.queue;
    this.syncing = true;
    return this.enqueue(async () => {
      try {
        let target: number;
        do {
          target = this.requestedSize;
          if (this.snapshot.status !== "ready" || target < this.end) await this.reopen(target);
          else if (target > this.end) await this.append(target);
        } while (this.requestedSize !== target);
      } finally {
        this.syncing = false;
      }
    });
  }

  loadEarlier(): Promise<void> {
    return this.enqueue(async () => {
      if (this.start === 0 || this.snapshot.status !== "ready") return;
      const from = Math.max(0, this.start - this.chunkBytes);
      const bytes = await this.read(from, this.start - from);
      const kept = from > 0 ? afterFirstNewline(bytes) : bytes;
      const earlier = decodeUtf8(kept).split("\n");
      const joined = earlier.pop() ?? "";
      this.lines = [...earlier, `${joined}${this.lines[0] ?? ""}`, ...this.lines.slice(1)];
      this.start = from + (bytes.length - kept.length);
      this.publish("ready", null);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private async reopen(size: number): Promise<void> {
    const from = Math.max(0, size - this.chunkBytes);
    const bytes = await this.read(from, size - from);
    const kept = from > 0 ? afterFirstNewline(bytes) : bytes;
    this.carry = new Uint8Array(0);
    this.lines = [];
    this.open = false;
    this.start = from + (bytes.length - kept.length);
    this.end = size;
    this.push(this.decodeForward(kept));
    this.publish("ready", null);
  }

  private async append(size: number): Promise<void> {
    const bytes = await this.read(this.end, size - this.end);
    this.end += bytes.length;
    this.push(this.decodeForward(bytes));
    this.trim();
    this.publish("ready", null);
  }

  /**
   * Decodes bytes read past the end, holding back a character the read cut in two. Not
   * TextDecoder's `stream`: the phones' polyfill ignores it and would show U+FFFD for good.
   */
  private decodeForward(bytes: Uint8Array): string {
    const joined = new Uint8Array(this.carry.length + bytes.length);
    joined.set(this.carry);
    joined.set(bytes, this.carry.length);
    const complete = joined.length - incompleteUtf8Tail(joined);
    this.carry = joined.slice(complete);
    return decodeUtf8(joined.subarray(0, complete));
  }

  /** Builds a new lines array: a published snapshot never changes under its reader. */
  private push(text: string): void {
    if (text === "") return;
    const parts = text.split("\n");
    const lines = this.lines.slice();
    if (this.open && lines.length > 0) lines[lines.length - 1] += parts.shift() ?? "";
    this.open = !text.endsWith("\n");
    if (!this.open) parts.pop();
    lines.push(...parts);
    this.lines = lines;
  }

  private trim(): void {
    const excess = this.lines.length - this.maxLines;
    if (excess <= 0) return;
    for (const line of this.lines.slice(0, excess)) this.start += utf8Length(line) + 1;
    this.lines = this.lines.slice(excess);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const previous = this.queue;
    const run = async () => {
      await previous;
      if (this.disposed) return;
      try {
        await work();
      } catch (error) {
        this.publish("failed", error instanceof Error ? error.message : String(error));
      }
    };
    this.queue = run();
    return this.queue;
  }

  private publish(status: LogTailSnapshot["status"], error: string | null): void {
    if (this.disposed) return;
    this.snapshot = { status, lines: this.lines, start: this.start, error };
    for (const listener of this.listeners) listener();
  }
}

/** How many bytes at the end begin a UTF-8 character whose remaining bytes have not arrived. */
export function incompleteUtf8Tail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    let length = 1;
    if (byte >= 0xf0) length = 4;
    else if (byte >= 0xe0) length = 3;
    else if (byte >= 0xc0) length = 2;
    return length > back ? back : 0;
  }
  return 0;
}

/** A chunk read from mid-file starts mid-line, and maybe mid-character: skip to the next line. */
function afterFirstNewline(bytes: Uint8Array): Uint8Array {
  const index = bytes.indexOf(NEWLINE);
  return index < 0 ? bytes : bytes.subarray(index + 1);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Colors, cursor moves and window titles that terminals interpret and a text view shows as noise.
const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex -- every terminal escape starts with ESC.
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** A log line as text: terminal escape codes and the carriage return of CRLF removed. */
export function displayLogLine(line: string): string {
  return line.replace(ANSI_ESCAPE, "").replace(/\r$/, "");
}
