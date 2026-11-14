import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phones resolve decode-utf8 to its native variant, and their only TextDecoder is the Buffer
// polyfill (polyfills/install-crypto-polyfills.ts), which keeps a BOM and ignores `stream`.
vi.mock("@/utils/decode-utf8", () => import("@/utils/decode-utf8.native"));

class BufferTextDecoder {
  decode(input?: Uint8Array): string {
    if (!input) return "";
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("utf8");
  }
}

describe("text decoding on iOS and Android", () => {
  beforeEach(() => {
    vi.stubGlobal("TextDecoder", BufferTextDecoder);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves a UTF-8 file that starts with a BOM byte for byte", async () => {
    const { decodeText, encodeText } = await import("./file/text-encoding");
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hi\r\n")]);
    const { text, encoding } = decodeText(bytes);
    expect(text).toBe("hi\r\n");
    expect(new TextEncoder().encode(encodeText(text, encoding) as string)).toEqual(bytes);
  });

  it("keeps characters a log read cut in two whole", async () => {
    const { LogTail } = await import("./log/tail");
    const bytes = new TextEncoder().encode("😀 café\n");
    const tail = new LogTail(async (offset, length) => bytes.slice(offset, offset + length), 1024);
    // The file grew inside the emoji, then inside the é.
    for (const size of [2, 9, bytes.length]) await tail.sync(size);
    expect(tail.getSnapshot().lines).toEqual(["😀 café"]);
  });
});
