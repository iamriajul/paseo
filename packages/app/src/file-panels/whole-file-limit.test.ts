import { describe, expect, it } from "vitest";
import { exceedsWholeFilePreview, WHOLE_FILE_PREVIEW_MAX_BYTES } from "./whole-file-limit";

const MB = 1024 * 1024;

describe("exceedsWholeFilePreview", () => {
  it("stops image, PDF and Office panels past the platform's cap", () => {
    for (const panelId of ["builtin:image", "builtin:pdf", "builtin:office"]) {
      expect(exceedsWholeFilePreview({ panelId, size: 64 * MB, platform: "web" })).toBe(false);
      expect(exceedsWholeFilePreview({ panelId, size: 64 * MB + 1, platform: "web" })).toBe(true);
      expect(exceedsWholeFilePreview({ panelId, size: 32 * MB, platform: "native" })).toBe(false);
      expect(exceedsWholeFilePreview({ panelId, size: 33 * MB, platform: "native" })).toBe(true);
    }
  });

  it("leaves streaming, text and plugin panels to their own limits", () => {
    const size = WHOLE_FILE_PREVIEW_MAX_BYTES.web * 10;
    for (const panelId of ["builtin:media", "builtin:source", "builtin:markdown", "plugin:x/y"]) {
      expect(exceedsWholeFilePreview({ panelId, size, platform: "web" })).toBe(false);
    }
  });
});
