import { decodeUtf8 } from "@/utils/decode-utf8";

/** How a text file's bytes encode its text, so saving writes them back the same way. */
export type TextEncodingName = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be";

/**
 * Decodes a text file by its byte order mark: UTF-16 in either byte order, otherwise UTF-8
 * (with or without a BOM). Malformed sequences become U+FFFD instead of failing.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes.subarray(2), true), encoding: "utf-16le" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes.subarray(2), false), encoding: "utf-16be" };
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  // Not the runtime's TextDecoder: on phones that is a slow polyfill that keeps the BOM, so each
  // save would add another. decodeUtf8 drops it, on the engine's fast path.
  return { text: decodeUtf8(bytes), encoding: bom ? "utf-8-bom" : "utf-8" };
}

/** The text as `encoding` writes it: UTF-8 as a string, the others as bytes with their BOM. */
export function encodeText(text: string, encoding: TextEncodingName): string | Uint8Array {
  if (encoding === "utf-8") return text;
  if (encoding === "utf-8-bom") return `﻿${text}`;
  const bytes = new Uint8Array(2 + text.length * 2);
  const littleEndian = encoding === "utf-16le";
  bytes[0] = littleEndian ? 0xff : 0xfe;
  bytes[1] = littleEndian ? 0xfe : 0xff;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    bytes[2 + index * 2] = littleEndian ? unit & 0xff : unit >> 8;
    bytes[3 + index * 2] = littleEndian ? unit >> 8 : unit & 0xff;
  }
  return bytes;
}

/** Hermes has no UTF-16 TextDecoder, so the code units are read directly. */
function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const parts: string[] = [];
  const units: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    units.push(
      littleEndian
        ? bytes[index] | (bytes[index + 1] << 8)
        : (bytes[index] << 8) | bytes[index + 1],
    );
    if (units.length === 8192) parts.push(String.fromCharCode(...units.splice(0)));
  }
  parts.push(String.fromCharCode(...units));
  return parts.join("");
}
