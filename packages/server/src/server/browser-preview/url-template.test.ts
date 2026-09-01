import { describe, expect, it } from "vitest";
import { parseBrowserPreviewTemplate } from "./url-template.js";

describe("parseBrowserPreviewTemplate", () => {
  it("builds a URL for a port using a dedicated wildcard", () => {
    const t = parseBrowserPreviewTemplate("https://{port}.preview.example.com");
    expect(t.buildUrl(3000)).toBe("https://3000.preview.example.com");
  });

  it("builds a URL for a port in a shared orchestrated wildcard", () => {
    const t = parseBrowserPreviewTemplate("https://{port}--daemon-1.studio.example.com");
    expect(t.buildUrl(5173)).toBe("https://5173--daemon-1.studio.example.com");
  });

  it("preserves an explicit port on the template origin", () => {
    const t = parseBrowserPreviewTemplate("https://{port}.preview.example.com:8443");
    expect(t.buildUrl(3000)).toBe("https://3000.preview.example.com:8443");
  });

  it("recovers the port from a matching Host header", () => {
    const t = parseBrowserPreviewTemplate("https://{port}--daemon-1.studio.example.com");
    expect(t.matchHost("3000--daemon-1.studio.example.com")).toBe(3000);
  });

  it("recovers the port when the Host header carries a port and mixed case", () => {
    const t = parseBrowserPreviewTemplate("https://{port}.preview.example.com");
    expect(t.matchHost("3000.PREVIEW.example.com:443")).toBe(3000);
  });

  it("returns null for hosts that do not match the template", () => {
    const t = parseBrowserPreviewTemplate("https://{port}--daemon-1.studio.example.com");
    expect(t.matchHost("daemon-1.studio.example.com")).toBeNull();
    expect(t.matchHost("3000--daemon-2.studio.example.com")).toBeNull();
    expect(t.matchHost("dev--miniweb.studio.example.com")).toBeNull();
    expect(t.matchHost("30x0--daemon-1.studio.example.com")).toBeNull();
    expect(t.matchHost(undefined)).toBeNull();
  });

  it("rejects ports outside 1..65535", () => {
    const t = parseBrowserPreviewTemplate("https://{port}.preview.example.com");
    expect(t.matchHost("0.preview.example.com")).toBeNull();
    expect(t.matchHost("65536.preview.example.com")).toBeNull();
    expect(t.matchHost("099.preview.example.com")).toBeNull();
  });

  it("rejects a template with no placeholder or more than one", () => {
    expect(() => parseBrowserPreviewTemplate("https://preview.example.com")).toThrow(
      /Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/,
    );
    expect(() => parseBrowserPreviewTemplate("https://{port}.{port}.example.com")).toThrow(
      /Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/,
    );
  });

  it("rejects a placeholder outside the hostname", () => {
    expect(() => parseBrowserPreviewTemplate("https://preview.example.com/{port}")).toThrow(
      /must appear in the hostname/,
    );
  });

  it("rejects a non-http scheme and an unparseable template", () => {
    expect(() => parseBrowserPreviewTemplate("ftp://{port}.preview.example.com")).toThrow(
      /Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/,
    );
    expect(() => parseBrowserPreviewTemplate("not a url {port}")).toThrow(
      /Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/,
    );
  });

  it("supports a placeholder that is not at the start of its label", () => {
    const t = parseBrowserPreviewTemplate("https://preview-{port}.example.com");
    expect(t.buildUrl(8080)).toBe("https://preview-8080.example.com");
    expect(t.matchHost("preview-8080.example.com")).toBe(8080);
    expect(t.matchHost("preview-.example.com")).toBeNull();
  });

  it("rejects a label that exceeds 63 characters with a five-digit port", () => {
    const long = "a".repeat(60);
    expect(() => parseBrowserPreviewTemplate(`https://{port}--${long}.example.com`)).toThrow(
      /63 characters/,
    );
  });
});
