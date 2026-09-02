import { describe, expect, it } from "vitest";
import {
  getUnsupportedIframeProtocol,
  resolveWebBrowserSrc,
  toDisplayUrl,
} from "./web-preview-url";

const template = "https://{port}--daemon-1.studio.example.com";

describe("resolveWebBrowserSrc", () => {
  it("routes localhost with a port through the template", () => {
    expect(resolveWebBrowserSrc({ url: "http://localhost:3000/app", template })).toEqual({
      kind: "preview",
      src: "https://3000--daemon-1.studio.example.com/app",
    });
  });

  it("routes 127.0.0.1 and [::1] through the template", () => {
    expect(resolveWebBrowserSrc({ url: "http://127.0.0.1:5173/", template })).toEqual({
      kind: "preview",
      src: "https://5173--daemon-1.studio.example.com/",
    });
    expect(resolveWebBrowserSrc({ url: "http://[::1]:5173/", template })).toEqual({
      kind: "preview",
      src: "https://5173--daemon-1.studio.example.com/",
    });
  });

  it("preserves query and hash", () => {
    expect(resolveWebBrowserSrc({ url: "http://localhost:3000/a?b=1#c", template })).toMatchObject({
      src: "https://3000--daemon-1.studio.example.com/a?b=1#c",
    });
  });

  it("routes unspecified addresses through the template as localhost", () => {
    expect(resolveWebBrowserSrc({ url: "http://0.0.0.0:3000/", template })).toEqual({
      kind: "preview",
      src: "https://3000--daemon-1.studio.example.com/",
    });
    expect(resolveWebBrowserSrc({ url: "http://[::]:3000/", template })).toEqual({
      kind: "preview",
      src: "https://3000--daemon-1.studio.example.com/",
    });
  });

  it("loads non-loopback URLs directly", () => {
    expect(resolveWebBrowserSrc({ url: "https://example.com/x", template })).toEqual({
      kind: "direct",
      src: "https://example.com/x",
    });
  });

  it("reports no-template only for loopback URLs", () => {
    expect(resolveWebBrowserSrc({ url: "http://localhost:3000/", template: null })).toEqual({
      kind: "no-template",
    });
    expect(resolveWebBrowserSrc({ url: "https://example.com/", template: null })).toEqual({
      kind: "direct",
      src: "https://example.com/",
    });
  });
});

describe("getUnsupportedIframeProtocol", () => {
  it("allows http and https", () => {
    expect(getUnsupportedIframeProtocol("http://example.com/")).toBeNull();
    expect(getUnsupportedIframeProtocol("https://example.com/")).toBeNull();
  });

  it("flags other schemes", () => {
    expect(getUnsupportedIframeProtocol("javascript:alert(1)")).toBe("javascript:");
    expect(getUnsupportedIframeProtocol("file:///etc/passwd")).toBe("file:");
  });

  it("does not flag a URL it can't parse", () => {
    expect(getUnsupportedIframeProtocol("not a url")).toBeNull();
  });
});

const TEMPLATE = "https://{port}.preview.example.com";

describe("toDisplayUrl", () => {
  it("maps a preview origin back to localhost", () => {
    expect(
      toDisplayUrl({
        url: "https://3000.preview.example.com/about?q=1#x",
        template: TEMPLATE,
        originalUrl: "http://localhost:3000/",
      }),
    ).toBe("http://localhost:3000/about?q=1#x");
  });

  it("keeps the loopback hostname the user typed", () => {
    expect(
      toDisplayUrl({
        url: "https://3000.preview.example.com/a",
        template: TEMPLATE,
        originalUrl: "http://127.0.0.1:3000/",
      }),
    ).toBe("http://127.0.0.1:3000/a");
  });

  it("passes a non-preview url through untouched", () => {
    expect(
      toDisplayUrl({
        url: "https://example.com/page",
        template: TEMPLATE,
        originalUrl: "https://example.com/",
      }),
    ).toBe("https://example.com/page");
  });

  it("does not graft a foreign origin's path onto the loopback url", () => {
    expect(
      toDisplayUrl({
        url: "https://example.com/page",
        template: TEMPLATE,
        originalUrl: "http://localhost:3000/",
      }),
    ).toBe("https://example.com/page");
  });

  it("passes through when there is no template", () => {
    expect(
      toDisplayUrl({
        url: "https://a.example/x",
        template: null,
        originalUrl: "https://a.example",
      }),
    ).toBe("https://a.example/x");
  });

  it("round-trips with resolveWebBrowserSrc", () => {
    const original = "http://localhost:5173/nested/path?a=b";
    const resolved = resolveWebBrowserSrc({ url: original, template: TEMPLATE });
    expect(resolved.kind).toBe("preview");
    if (resolved.kind !== "preview") return;
    expect(toDisplayUrl({ url: resolved.src, template: TEMPLATE, originalUrl: original })).toBe(
      original,
    );
  });
});
