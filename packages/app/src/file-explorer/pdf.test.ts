import { describe, expect, it } from "vitest";
import { isPdfMimeType, shouldPersistFilePreviewMedia } from "./pdf";

describe("isPdfMimeType", () => {
  it("recognizes PDF media types case-insensitively and with parameters", () => {
    expect(isPdfMimeType("application/pdf")).toBe(true);
    expect(isPdfMimeType("Application/PDF; version=1.7")).toBe(true);
    expect(isPdfMimeType("application/octet-stream")).toBe(false);
  });
});

describe("shouldPersistFilePreviewMedia", () => {
  it("persists images and PDFs so the pane can render them", () => {
    expect(shouldPersistFilePreviewMedia({ kind: "image", mime: "image/png" })).toBe(true);
    expect(shouldPersistFilePreviewMedia({ kind: "binary", mime: "application/pdf" })).toBe(true);
    expect(
      shouldPersistFilePreviewMedia({ kind: "binary", mime: "application/octet-stream" }),
    ).toBe(false);
    expect(shouldPersistFilePreviewMedia({ kind: "text", mime: "text/plain" })).toBe(false);
  });
});
