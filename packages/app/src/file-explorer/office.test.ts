import { describe, expect, it } from "vitest";
import { officePreviewKind } from "./office";

describe("officePreviewKind", () => {
  it("recognizes Word, Excel, and PowerPoint media types, including parameters", () => {
    expect(
      officePreviewKind({
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe("docx");
    expect(
      officePreviewKind({
        mimeType:
          "Application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=binary",
      }),
    ).toBe("xlsx");
    expect(
      officePreviewKind({
        mimeType: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
      }),
    ).toBe("pptx");
  });

  it("falls back to the extension when the daemon still says octet-stream", () => {
    expect(
      officePreviewKind({ mimeType: "application/octet-stream", path: "reports/Q1.DOCX" }),
    ).toBe("docx");
    expect(officePreviewKind({ mimeType: "application/octet-stream", path: "model.xltx" })).toBe(
      "xlsx",
    );
    expect(officePreviewKind({ path: "talks/launch.potm" })).toBe("pptx");
  });

  it("does not claim PDF, text, or legacy OLE documents", () => {
    expect(officePreviewKind({ mimeType: "application/pdf", path: "brief.pdf" })).toBeNull();
    expect(officePreviewKind({ mimeType: "text/plain", path: "notes.csv" })).toBeNull();
    expect(officePreviewKind({ mimeType: "application/msword", path: "old.doc" })).toBeNull();
    expect(
      officePreviewKind({ mimeType: "application/octet-stream", path: "blob.bin" }),
    ).toBeNull();
  });
});
