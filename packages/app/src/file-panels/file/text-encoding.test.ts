import { describe, expect, it } from "vitest";
import { decodeText, encodeText, type TextEncodingName } from "./text-encoding";

const text = "Größe: 😀\r\nzweite Zeile";

describe("decodeText and encodeText", () => {
  it.each<[TextEncodingName, string]>([
    ["utf-16le", "utf-16le"],
    ["utf-16be", "utf-16be"],
  ])("reads %s by its BOM and writes it back byte for byte", (encoding) => {
    const bytes = encodeText(text, encoding);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const decoded = decodeText(bytes as Uint8Array);
    expect(decoded).toEqual({ text, encoding });
    expect(encodeText(decoded.text, decoded.encoding)).toEqual(bytes);
  });

  it("matches the platform's UTF-16LE encoder", () => {
    const bytes = encodeText(text, "utf-16le") as Uint8Array;
    expect(Buffer.from(bytes.subarray(2)).toString("utf16le")).toBe(text);
  });

  it("keeps a UTF-8 BOM on save and leaves plain UTF-8 alone", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hi")]);
    expect(decodeText(withBom)).toEqual({ text: "hi", encoding: "utf-8-bom" });
    expect(encodeText("hi", "utf-8-bom")).toBe("﻿hi");
    expect(decodeText(new TextEncoder().encode("hi"))).toEqual({ text: "hi", encoding: "utf-8" });
    expect(encodeText("hi", "utf-8")).toBe("hi");
  });

  it("decodes a long UTF-16 file in pieces", () => {
    const long = "x".repeat(100_000);
    expect(decodeText(encodeText(long, "utf-16le") as Uint8Array).text).toBe(long);
  });
});
