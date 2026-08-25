import { describe, expect, it } from "vitest";
import { getUnsupportedIframeProtocol, resolveWebBrowserSrc } from "./web-preview-url";

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
