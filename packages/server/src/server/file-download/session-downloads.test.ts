import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { SessionDownloads } from "./session-downloads.js";

const KB = 1024;

function openChunks(downloads: SessionDownloads, chunks: Buffer[]): string {
  return downloads.open({
    fileName: "a.zip",
    mimeType: "application/zip",
    size: null,
    readable: Readable.from(chunks),
    abort: new AbortController(),
  });
}

describe("SessionDownloads", () => {
  test("sends small producer chunks as frames of up to 256 KB, bytes in order", async () => {
    const downloads = new SessionDownloads();
    const chunks = Array.from({ length: 100 }, (_, index) => Buffer.alloc(16 * KB, index));
    const id = openChunks(downloads, chunks);

    const slice = await downloads.read(id, 2048 * KB);

    expect(slice.chunks.map((frame) => frame.byteLength)).toEqual([
      ...Array(6).fill(256 * KB),
      64 * KB,
    ]);
    expect(Buffer.concat(slice.chunks).equals(Buffer.concat(chunks))).toBe(true);
    expect(slice).toMatchObject({ bytes: 1600 * KB, done: true });
    downloads.closeAll();
  });

  test("splits a chunk across reads at maxBytes and keeps the rest for the next read", async () => {
    const downloads = new SessionDownloads();
    const id = openChunks(downloads, [Buffer.from("abcdef"), Buffer.from("gh")]);

    const first = await downloads.read(id, 4);
    const second = await downloads.read(id, 4);
    const third = await downloads.read(id, 4);

    expect(Buffer.concat(first.chunks).toString()).toBe("abcd");
    expect(first.done).toBe(false);
    expect(Buffer.concat(second.chunks).toString()).toBe("efgh");
    expect(third).toMatchObject({ bytes: 0, done: true });
    downloads.closeAll();
  });

  test("answers pipelined reads in order", async () => {
    const downloads = new SessionDownloads();
    const id = openChunks(downloads, [Buffer.from("0123456789")]);

    const reads = await Promise.all([1, 2, 3].map(() => downloads.read(id, 4)));

    expect(reads.map((read) => Buffer.concat(read.chunks).toString())).toEqual([
      "0123",
      "4567",
      "89",
    ]);
    downloads.closeAll();
  });
});
