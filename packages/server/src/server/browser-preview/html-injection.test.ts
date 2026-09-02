import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  INJECTION_SCAN_LIMIT_BYTES,
  createHtmlInjectionStream,
  findHeadInjectionOffset,
  rewriteHtmlHead,
  stripMetaCsp,
} from "./html-injection.js";

const SCRIPTS = "<script>BRIDGE</script>";

describe("findHeadInjectionOffset", () => {
  it("inserts immediately after <head>", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
    expect(findHeadInjectionOffset(html)).toBe(html.indexOf("<head>") + "<head>".length);
  });

  it("handles <head> with attributes", () => {
    const html = `<html><head data-x="1"><title>x</title></head></html>`;
    expect(findHeadInjectionOffset(html)).toBe(html.indexOf(">", html.indexOf("<head")) + 1);
  });

  it("is case-insensitive", () => {
    const html = "<!DOCTYPE HTML><HTML><HEAD></HEAD></HTML>";
    expect(findHeadInjectionOffset(html)).toBe(html.indexOf("<HEAD>") + "<HEAD>".length);
  });

  // A script before <!doctype html> throws the document into quirks mode, which
  // silently changes layout in the page we are supposed to be previewing faithfully.
  it("never inserts before a doctype", () => {
    const html = "<!doctype html><html><body>hi</body></html>";
    const offset = findHeadInjectionOffset(html);
    expect(offset).toBeGreaterThanOrEqual("<!doctype html>".length);
  });

  // A comment before the doctype is legal HTML5 and shows up in build banners and
  // license headers. A literal <head> inside one must not pull the offset back.
  it("never inserts before a doctype when a comment before it contains a head tag", () => {
    const html = "<!-- build: <head> --><!doctype html><html><head><title>x</title></head></html>";
    const doctypeEnd = html.indexOf("<!doctype html>") + "<!doctype html>".length;
    const offset = findHeadInjectionOffset(html);
    expect(offset).toBeGreaterThanOrEqual(doctypeEnd);
    // Search from the doctype: the first "<head>" in the string is the decoy in
    // the comment, which is the offset this test exists to reject.
    expect(offset).toBe(html.indexOf("<head>", doctypeEnd) + "<head>".length);
  });

  // The word boundary after "head" is all that stops <header> from winning the
  // match and putting the bridge in the body, after the page's own scripts.
  it("does not match <header>", () => {
    expect(findHeadInjectionOffset("<div><header>hi</header></div>")).toBe(0);
  });

  it("falls back to after <html> when there is no head", () => {
    const html = "<!doctype html><html><body>hi</body></html>";
    expect(findHeadInjectionOffset(html)).toBe(html.indexOf("<html>") + "<html>".length);
  });

  it("falls back to after the doctype when there is no html element", () => {
    const html = "<!doctype html><body>hi</body>";
    expect(findHeadInjectionOffset(html)).toBe("<!doctype html>".length);
  });

  it("returns 0 for a bare fragment", () => {
    expect(findHeadInjectionOffset("<div>hi</div>")).toBe(0);
  });
});

describe("stripMetaCsp", () => {
  it("removes a meta CSP tag", () => {
    const html = `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><title>x</title></head>`;
    const out = stripMetaCsp(html);
    expect(out).not.toContain("Content-Security-Policy");
    expect(out).toContain("<title>x</title>");
  });

  it("removes the report-only variant and single-quoted attributes", () => {
    const html = `<meta http-equiv='content-security-policy-report-only' content='x'>`;
    expect(stripMetaCsp(html)).toBe("");
  });

  it("removes it with content before http-equiv and unquoted attributes", () => {
    expect(
      stripMetaCsp(`<meta content="default-src 'self'" http-equiv="content-security-policy">`),
    ).toBe("");
    expect(stripMetaCsp("<meta http-equiv=content-security-policy content=x>")).toBe("");
  });

  it("leaves unrelated meta tags alone", () => {
    const html = `<meta charset="utf-8"><meta name="viewport" content="width=device-width">`;
    expect(stripMetaCsp(html)).toBe(html);
  });
});

describe("rewriteHtmlHead", () => {
  it("inserts the scripts and strips meta CSP in one pass", () => {
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="x"><title>t</title></head><body></body></html>`;
    const out = rewriteHtmlHead(html, SCRIPTS);
    expect(out).not.toContain("Content-Security-Policy");
    expect(out.indexOf(SCRIPTS)).toBe(out.indexOf("<head>") + "<head>".length);
    expect(out).toContain("<title>t</title>");
  });

  it("puts the bridge before any page script", () => {
    const html = `<html><head><script src="/app.js"></script></head><body></body></html>`;
    const out = rewriteHtmlHead(html, SCRIPTS);
    expect(out.indexOf(SCRIPTS)).toBeLessThan(out.indexOf("/app.js"));
  });

  it("exposes a 64 KiB scan limit", () => {
    expect(INJECTION_SCAN_LIMIT_BYTES).toBe(65536);
  });
});

async function pumpChunks(
  chunks: readonly (string | Buffer)[],
  scripts: string,
): Promise<Buffer[]> {
  const stream = Readable.from(
    chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))),
  ).pipe(createHtmlInjectionStream(scripts));
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(chunk as Buffer);
  return out;
}

async function pump(chunks: readonly (string | Buffer)[], scripts: string): Promise<string> {
  return Buffer.concat(await pumpChunks(chunks, scripts)).toString("utf8");
}

// Everything the transform has pushed so far, as one string. read() with no
// argument drains the entire readable buffer in paused mode, so the result does
// not depend on how many push calls produced it — the question here is what has
// left the transform, never how it was cut up on the way out.
function drain(stream: Readable): string {
  const parts: Buffer[] = [];
  let chunk = stream.read() as Buffer | null;
  while (chunk !== null) {
    parts.push(chunk);
    chunk = stream.read() as Buffer | null;
  }
  return Buffer.concat(parts).toString("utf8");
}

describe("createHtmlInjectionStream", () => {
  it("injects once and passes the body through", async () => {
    const out = await pump(
      ["<!doctype html><html><head><title>t</title></head>", "<body>hello</body></html>"],
      SCRIPTS,
    );
    expect(out).toContain(SCRIPTS);
    expect(out).toContain("<body>hello</body>");
    expect(out.split(SCRIPTS)).toHaveLength(2);
  });

  // The insertion point can straddle a chunk boundary; a naive per-chunk
  // implementation silently misses it and the page loads with no bridge.
  it("finds an injection point split across chunks", async () => {
    const out = await pump(["<!doctype html><ht", "ml><he", "ad></head><body></body>"], SCRIPTS);
    expect(out).toContain(SCRIPTS);
    expect(out.indexOf(SCRIPTS)).toBeGreaterThan(out.indexOf("<head>"));
  });

  it("strips meta CSP appearing after the injection point", async () => {
    const out = await pump(
      [`<html><head><meta http-equiv="Content-Security-Policy" content="x"></head><body>b</body>`],
      SCRIPTS,
    );
    expect(out).not.toContain("Content-Security-Policy");
    expect(out).toContain("<body>b</body>");
  });

  // Counting the consumer's chunks proves nothing about the transform: read()
  // hands back the whole readable buffer at once in paused mode, so two
  // synchronous pushes surface as one chunk on Node 22 and as two on Node 26.
  // What actually separates this from a transform that buffered the document
  // and rewrote it in flush is that such a transform has emitted nothing at all
  // until end() — so read before ending, and concatenate whatever comes back so
  // that batching cannot change the answer.
  it("stops buffering after </head> so the body streams", async () => {
    const big = "x".repeat(200_000);
    const stream = createHtmlInjectionStream(SCRIPTS);

    stream.write("<html><head></head><body>");
    const head = drain(stream);
    expect(head).toContain(SCRIPTS);

    stream.write(big);
    const body = drain(stream);
    expect(body).toContain(big);

    stream.end("</body></html>");
    const tail: Buffer[] = [];
    for await (const chunk of stream) tail.push(chunk as Buffer);
    expect(head + body + Buffer.concat(tail).toString("utf8")).toBe(
      `<html><head>${SCRIPTS}</head><body>${big}</body></html>`,
    );
  });

  // Identical bytes must produce identical output however upstream chunked them.
  // A search over all of pending that consults the cap only afterwards finds this
  // </head> and injects, while the same bytes split either side of the cap stream
  // through untouched.
  it("gives up on a </head> that closes past the cap in a single chunk", async () => {
    const doc = `<html><head><!-- ${"y".repeat(70_000)} --></head><body>b</body></html>`;
    const out = await pump([doc], SCRIPTS);
    expect(out).not.toContain(SCRIPTS);
    expect(out).toBe(doc);
  });

  it("passes through unmodified when no injection point arrives within the cap", async () => {
    const filler = `<!-- ${"y".repeat(INJECTION_SCAN_LIMIT_BYTES)} -->`;
    const out = await pump([filler, "<html><head></head>"], SCRIPTS);
    expect(out).not.toContain(SCRIPTS);
    expect(out).toBe(`${filler}<html><head></head>`);
  });

  it("still injects when the stream ends before </head>", async () => {
    const out = await pump(["<html><head><title>only</title>"], SCRIPTS);
    expect(out).toContain(SCRIPTS);
  });

  // Splits a 3-byte character down the middle, across the chunk boundary. A
  // transform that decodes each accumulated chunk as utf8 turns the halves
  // into U+FFFD and this assertion fails.
  it("does not corrupt a multi-byte character split across chunks", async () => {
    const full = Buffer.from("<html><head></head><body>日本語テキスト</body></html>", "utf8");
    const splitAt = full.indexOf(Buffer.from("日", "utf8")) + 1;
    const out = await pump([full.subarray(0, splitAt), full.subarray(splitAt)], SCRIPTS);
    expect(out).toContain("日本語テキスト");
    expect(out).not.toContain("�");
  });

  // The brief's named hazard: findHeadInjectionOffset returns a UTF-16 index, so
  // a search that runs in utf8 while still slicing the Buffer at the match index
  // is off by (bytes - UTF-16 units). Every other test here is ASCII up to
  // </head>, where the two coincide and the bug is invisible. Ten 3-byte
  // characters put the shortfall mid-character; with nine it lands exactly on a
  // character boundary and the mutation escapes again.
  it("does not corrupt a head containing multi-byte characters", async () => {
    const out = await pump(
      ["<html><head><title>日本語日本語日本語日</title></head><body>b</body></html>"],
      SCRIPTS,
    );
    expect(out).not.toContain("�");
    expect(out).toContain("<title>日本語日本語日本語日</title>");
    expect(out).toContain(SCRIPTS);
    expect(out).toContain("<body>b</body>");
  });

  // Same hazard on the give-up path: the raw bytes must pass through
  // untouched rather than surviving a decode round-trip.
  it("does not corrupt multi-byte content when it gives up at the cap", async () => {
    const filler = Buffer.from(`<!-- ${"y".repeat(INJECTION_SCAN_LIMIT_BYTES)} 日本語 -->`, "utf8");
    const splitAt = filler.indexOf(Buffer.from("日", "utf8")) + 1;
    const out = await pump([filler.subarray(0, splitAt), filler.subarray(splitAt)], SCRIPTS);
    expect(out).toContain("日本語");
    expect(out).not.toContain("�");
  });
});
