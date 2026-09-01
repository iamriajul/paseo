import { describe, expect, it } from "vitest";
import { resolveBrowserPreviewUrlTemplate } from "./config.js";

describe("resolveBrowserPreviewUrlTemplate", () => {
  it("returns null when neither env nor persisted config sets one", () => {
    expect(resolveBrowserPreviewUrlTemplate({}, {})).toBeNull();
  });

  it("reads the persisted value", () => {
    expect(
      resolveBrowserPreviewUrlTemplate(
        {},
        { daemon: { browserPreview: { urlTemplate: "https://{port}.preview.example.com" } } },
      ),
    ).toBe("https://{port}.preview.example.com");
  });

  it("prefers the environment variable over persisted config", () => {
    expect(
      resolveBrowserPreviewUrlTemplate(
        { PASEO_BROWSER_PREVIEW_URL_TEMPLATE: "https://{port}--daemon-1.studio.example.com" },
        { daemon: { browserPreview: { urlTemplate: "https://{port}.preview.example.com" } } },
      ),
    ).toBe("https://{port}--daemon-1.studio.example.com");
  });

  it("throws on an invalid template so startup fails loudly", () => {
    expect(() =>
      resolveBrowserPreviewUrlTemplate(
        { PASEO_BROWSER_PREVIEW_URL_TEMPLATE: "https://no-placeholder.example.com" },
        {},
      ),
    ).toThrow(/Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE/);
  });

  it("throws when the placeholder is in the path", () => {
    expect(() =>
      resolveBrowserPreviewUrlTemplate(
        { PASEO_BROWSER_PREVIEW_URL_TEMPLATE: "https://preview.example.com/{port}" },
        {},
      ),
    ).toThrow(/must appear in the hostname/);
  });

  it("throws on an empty environment variable instead of silently returning null", () => {
    expect(() =>
      resolveBrowserPreviewUrlTemplate(
        { PASEO_BROWSER_PREVIEW_URL_TEMPLATE: "" },
        { daemon: { browserPreview: { urlTemplate: "https://{port}.preview.example.com" } } },
      ),
    ).toThrow(/template must contain \{port\} exactly once/);
  });
});
