import { Transform } from "node:stream";

// Bounds how much of a response is held in memory looking for an injection
// point. Past it the body streams unmodified: a document whose <head> has not
// closed inside 64 KiB is not one worth delaying.
export const INJECTION_SCAN_LIMIT_BYTES = 65536;

// Matches <meta http-equiv="content-security-policy"> and its report-only
// variant, in either attribute order and with any quoting style. The proxy
// strips the response header elsewhere; a meta tag survives that and would
// block the injected bridge.
const META_CSP_PATTERN =
  /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy(?:-report-only)?["']?)[^>]*>/gi;

function offsetAfterOpenTag(html: string, tagName: string): number | null {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const match = pattern.exec(html);
  if (match === null) return null;
  return match.index + match[0].length;
}

// Returns a string index, not a byte count; callers slice the same string.
export function findHeadInjectionOffset(html: string): number {
  // Nothing may precede the doctype: a node before it puts the whole document
  // into quirks mode, which changes the layout of the page we are previewing.
  // Locating it first and searching only what follows makes that structural —
  // a comment before the doctype holding a literal <head> cannot pull the
  // offset back in front of it.
  const doctype = /<!doctype\b[^>]*>/i.exec(html);
  const searchFrom = doctype === null ? 0 : doctype.index + doctype[0].length;
  const rest = html.slice(searchFrom);

  const head = offsetAfterOpenTag(rest, "head");
  if (head !== null) return searchFrom + head;

  const htmlTag = offsetAfterOpenTag(rest, "html");
  if (htmlTag !== null) return searchFrom + htmlTag;

  return searchFrom;
}

export function stripMetaCsp(html: string): string {
  return html.replace(META_CSP_PATTERN, "");
}

export function rewriteHtmlHead(windowText: string, scripts: string): string {
  const stripped = stripMetaCsp(windowText);
  const offset = findHeadInjectionOffset(stripped);
  return stripped.slice(0, offset) + scripts + stripped.slice(offset);
}

// Buffers until </head> closes (or the cap, or end of stream), rewrites that
// window once, then passes every later byte through untouched. Holding only the
// head is what lets streaming SSR keep streaming: buffering the whole document
// would serialise a Suspense-streamed page into one late flush.
export function createHtmlInjectionStream(scripts: string): Transform {
  let pending: Buffer | null = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (pending === null) {
        // Window already emitted: straight passthrough, byte for byte.
        callback(null, chunk);
        return;
      }

      pending = Buffer.concat([pending, chunk]);

      // Clamped to the cap so the outcome never depends on how upstream chunked
      // the response: a </head> that closes past the cap has to lose whether it
      // arrived in one 100 KiB chunk or as 70 KiB + 30 KiB. Searching all of
      // pending and only checking the cap afterwards makes identical bytes
      // produce different output.
      const searchable =
        pending.byteLength > INJECTION_SCAN_LIMIT_BYTES
          ? pending.subarray(0, INJECTION_SCAN_LIMIT_BYTES)
          : pending;

      // Search in latin1, never utf8. Decoding a partial buffer replaces a
      // multi-byte character split across a chunk boundary with U+FFFD, and
      // re-encoding then ships the corruption downstream. latin1 is
      // byte-preserving and 1 byte == 1 char, so a match index here is a byte
      // offset — and every tag we look for is ASCII either way.
      const headEnd = /<\/head\s*>/i.exec(searchable.toString("latin1"));

      if (headEnd !== null) {
        const boundary = headEnd.index + headEnd[0].length;
        // The boundary sits just past '>', an ASCII byte, so the window never
        // ends mid-character and decoding it as utf8 is safe.
        const windowText = pending.subarray(0, boundary).toString("utf8");
        const rest = pending.subarray(boundary);
        pending = null;
        this.push(Buffer.from(rewriteHtmlHead(windowText, scripts), "utf8"));
        callback(null, rest.byteLength > 0 ? rest : undefined);
        return;
      }

      if (pending.byteLength >= INJECTION_SCAN_LIMIT_BYTES) {
        // Gave up looking. Emit the raw bytes untouched — no decode round-trip.
        const raw = pending;
        pending = null;
        callback(null, raw);
        return;
      }
      callback();
    },
    flush(callback) {
      if (pending === null) {
        callback();
        return;
      }
      // Stream ended before </head>. The whole buffer is the window, and it is
      // complete, so utf8 decoding is safe here.
      const windowText = pending.toString("utf8");
      pending = null;
      this.push(Buffer.from(rewriteHtmlHead(windowText, scripts), "utf8"));
      callback();
    },
  });
}
