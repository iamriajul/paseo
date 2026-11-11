import type {
  DownloadTarget,
  PrepareDownloadDestination,
} from "@/downloads/download-destination.types";

/** What a test destination saw, in order. */
export type DestinationEvent =
  | { type: "prepare"; suggestedName: string }
  | { type: "discard" }
  | { type: "begin"; target: DownloadTarget }
  | { type: "write"; bytes: number }
  | { type: "close" }
  | { type: "abort"; reason: string };

/** A destination that keeps written bytes in memory and records every call. */
export function memoryDownloadDestination(
  options: { dismiss?: boolean; uri?: string | null; onWrite?: (written: number) => void } = {},
) {
  const events: DestinationEvent[] = [];
  const written: Uint8Array[] = [];
  const prepare: PrepareDownloadDestination = async (suggestedName) => {
    events.push({ type: "prepare", suggestedName });
    if (options.dismiss) return null;
    return {
      discard: async () => {
        events.push({ type: "discard" });
      },
      begin: async (target) => {
        events.push({ type: "begin", target });
        return {
          write: async (chunk) => {
            written.push(chunk);
            events.push({ type: "write", bytes: chunk.byteLength });
            options.onWrite?.(written.length);
          },
          close: async () => {
            events.push({ type: "close" });
            return options.uri ?? null;
          },
          abort: async (reason) => {
            events.push({ type: "abort", reason: reason.message });
          },
        };
      },
    };
  };
  return {
    prepare,
    events,
    bytes: () => Buffer.concat(written),
  };
}

/** A stream that yields `chunks` lazily and records how many were pulled. */
export function fakeDownloadStream(
  chunks: Uint8Array[],
  meta: { fileName: string; mimeType: string; size: number | null; failAfter?: number },
) {
  const pulled = { count: 0, finished: false };
  async function* generate(): AsyncGenerator<Uint8Array> {
    try {
      for (const chunk of chunks) {
        if (meta.failAfter !== undefined && pulled.count >= meta.failAfter)
          throw new Error("Connection lost");
        pulled.count += 1;
        yield chunk;
      }
    } finally {
      pulled.finished = true;
    }
  }
  return {
    pulled,
    stream: {
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      size: meta.size,
      chunks: generate(),
    },
  };
}
