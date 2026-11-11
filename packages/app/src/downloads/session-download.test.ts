import { describe, expect, it } from "vitest";
import { runSessionDownload } from "@/downloads/session-download";
import { fakeDownloadStream, memoryDownloadDestination } from "@/test/memory-download-destination";

const CHUNKS = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
const META = { fileName: "big.bin", mimeType: "application/octet-stream", size: 6 };

describe("runSessionDownload", () => {
  it("writes every chunk in order, then closes the file", async () => {
    const destination = memoryDownloadDestination({ uri: "file:///cache/big.bin" });
    const { stream } = fakeDownloadStream(CHUNKS, META);
    const progress: number[] = [];
    let time = 0;

    const result = await runSessionDownload({
      destination: destination.prepare("big.bin"),
      open: async () => stream,
      signal: new AbortController().signal,
      onStart: () => undefined,
      onProgress: (update) => progress.push(update.bytesWritten),
      now: () => (time += 300),
    });

    expect(result).toEqual({
      status: "complete",
      fileName: "big.bin",
      mimeType: "application/octet-stream",
      uri: "file:///cache/big.bin",
    });
    expect([...destination.bytes()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(destination.events.map((event) => event.type)).toEqual([
      "prepare",
      "begin",
      "write",
      "write",
      "write",
      "close",
    ]);
    expect(progress).toEqual([3, 5, 6]);
  });

  it("pulls the next chunk only after the last one is written", async () => {
    const order: string[] = [];
    const destination = memoryDownloadDestination({
      onWrite: (count) => order.push(`write ${count}`),
    });
    async function* chunks() {
      for (const [index, chunk] of CHUNKS.entries()) {
        order.push(`pull ${index + 1}`);
        yield chunk;
      }
    }

    await runSessionDownload({
      destination: destination.prepare("big.bin"),
      open: async () => ({ ...META, chunks: chunks() }),
      signal: new AbortController().signal,
      onStart: () => undefined,
      onProgress: () => undefined,
    });

    expect(order).toEqual(["pull 1", "write 1", "pull 2", "write 2", "pull 3", "write 3"]);
  });

  it("drops the partial file when the transfer fails midway", async () => {
    const destination = memoryDownloadDestination();
    const { stream, pulled } = fakeDownloadStream(CHUNKS, { ...META, failAfter: 1 });

    await expect(
      runSessionDownload({
        destination: destination.prepare("big.bin"),
        open: async () => stream,
        signal: new AbortController().signal,
        onStart: () => undefined,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow("Connection lost");

    expect(destination.events.at(-1)).toEqual({ type: "abort", reason: "Connection lost" });
    expect(destination.events.some((event) => event.type === "close")).toBe(false);
    expect(pulled.finished).toBe(true);
  });

  it("stops reading and drops the file when cancelled", async () => {
    const abort = new AbortController();
    const destination = memoryDownloadDestination({ onWrite: () => abort.abort() });
    const { stream, pulled } = fakeDownloadStream(CHUNKS, META);

    const result = await runSessionDownload({
      destination: destination.prepare("big.bin"),
      open: async () => ({
        ...stream,
        // The client's stream throws the abort reason once the signal fires.
        chunks: (async function* () {
          for await (const chunk of stream.chunks) {
            if (abort.signal.aborted) throw new Error("aborted");
            yield chunk;
          }
        })(),
      }),
      signal: abort.signal,
      onStart: () => undefined,
      onProgress: () => undefined,
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(pulled.count).toBeLessThan(CHUNKS.length);
    expect(destination.events.at(-1)).toMatchObject({ type: "abort" });
  });

  it("never opens the download when the save prompt is dismissed", async () => {
    const destination = memoryDownloadDestination({ dismiss: true });
    let opened = false;

    const result = await runSessionDownload({
      destination: destination.prepare("big.bin"),
      open: async () => {
        opened = true;
        return fakeDownloadStream(CHUNKS, META).stream;
      },
      signal: new AbortController().signal,
      onStart: () => undefined,
      onProgress: () => undefined,
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(opened).toBe(false);
  });

  it("discards the chosen location when the daemon refuses to open", async () => {
    const destination = memoryDownloadDestination();

    await expect(
      runSessionDownload({
        destination: destination.prepare("big.bin"),
        open: async () => {
          throw new Error("Access outside of workspace is not allowed");
        },
        signal: new AbortController().signal,
        onStart: () => undefined,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow("Access outside of workspace is not allowed");
    expect(destination.events.map((event) => event.type)).toEqual(["prepare", "discard"]);
  });
});
