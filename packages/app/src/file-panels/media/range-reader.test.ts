import { describe, expect, it } from "vitest";
import { RangeReader, type OpenByteRange } from "./range-reader";

const FILE = Uint8Array.from({ length: 100 }, (_, index) => index);

/** A daemon download of FILE in 10-byte chunks that can be made to expire after some chunks. */
function fakeDaemon(options: { expireAfterChunks?: number } = {}) {
  const opens: { start: number; end: number }[] = [];
  const closed: number[] = [];
  const open: OpenByteRange = async (range, signal) => {
    opens.push(range);
    const index = opens.length - 1;
    return (async function* () {
      try {
        let sent = 0;
        for (let at = range.start; at <= range.end; at += 10) {
          if (signal.aborted) throw new Error("aborted");
          if (index === 0 && sent === options.expireAfterChunks) {
            throw new Error("Download not found or expired.");
          }
          sent += 1;
          yield FILE.slice(at, Math.min(at + 10, range.end + 1));
        }
      } finally {
        closed.push(index);
      }
    })();
  };
  return { open, opens, closed };
}

async function readAll(reader: RangeReader): Promise<number[]> {
  const bytes: number[] = [];
  for (let chunk = await reader.next(); chunk; chunk = await reader.next()) bytes.push(...chunk);
  return bytes;
}

describe("RangeReader", () => {
  it("reads exactly its range and closes the download at the end", async () => {
    const daemon = fakeDaemon();
    const reader = new RangeReader(daemon.open, { start: 25, end: 54 });
    expect(await readAll(reader)).toEqual(Array.from(FILE.slice(25, 55)));
    expect(daemon.opens).toEqual([{ start: 25, end: 54 }]);
    expect(daemon.closed).toEqual([0]);
  });

  it("fails the range when the daemon drops its download, and closes it", async () => {
    const daemon = fakeDaemon({ expireAfterChunks: 3 });
    const reader = new RangeReader(daemon.open, { start: 0, end: 99 });
    for (let chunk = 0; chunk < 3; chunk += 1) await reader.next();
    await expect(reader.next()).rejects.toThrow("Download not found or expired.");
    expect(daemon.opens).toEqual([{ start: 0, end: 99 }]);
    expect(daemon.closed).toEqual([0]);
  });

  it("closing mid-range ends the download and reads nothing more", async () => {
    const daemon = fakeDaemon();
    const reader = new RangeReader(daemon.open, { start: 0, end: 99 });
    expect(Array.from((await reader.next()) ?? [])).toEqual(Array.from(FILE.slice(0, 10)));
    reader.close();
    expect(await reader.next()).toBeNull();
    await Promise.resolve();
    expect(daemon.closed).toEqual([0]);
  });
});
