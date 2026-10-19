import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const kinds = ["docx", "xlsx", "pptx"] as const;

describe("office preview webview html", () => {
  it("refuses remote origins and still allows the excel blob reload", () => {
    for (const kind of kinds) {
      const source = readFileSync(
        new URL(`./office-preview-webview-${kind}-html.ts`, import.meta.url),
        "utf8",
      );
      const policyAt = source.indexOf("Content-Security-Policy");
      const scriptAt = source.indexOf("<script>");

      expect(policyAt).toBeGreaterThan(-1);
      expect(scriptAt).toBeGreaterThan(policyAt);
      expect(source).toContain("default-src \\'none\\'");
      expect(source).toContain("connect-src blob:");
      expect(source).toContain("script-src \\'unsafe-inline\\' \\'unsafe-eval\\' blob:");
      expect(source).not.toContain("connect-src https:");
      expect(source).not.toContain("connect-src *");
    }
  });
});
