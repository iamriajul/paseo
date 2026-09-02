import { describe, expect, it } from "vitest";
import {
  INJECTION_SCAN_LIMIT_BYTES,
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
