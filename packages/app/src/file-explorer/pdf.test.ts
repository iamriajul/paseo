import { describe, expect, it } from "vitest";
import { isPdfMimeType } from "./pdf";

describe("isPdfMimeType", () => {
  it("recognizes PDF media types case-insensitively and with parameters", () => {
    expect(isPdfMimeType("application/pdf")).toBe(true);
    expect(isPdfMimeType("Application/PDF; version=1.7")).toBe(true);
    expect(isPdfMimeType("application/octet-stream")).toBe(false);
  });
});
