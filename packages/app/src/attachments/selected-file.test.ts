import { describe, expect, it } from "vitest";
import { selectedFileFromDesktopPath, selectedFileFromWebFile } from "./selected-file";

describe("selected files", () => {
  it("reads web files lazily with a mime fallback", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const selected = selectedFileFromWebFile(file);
    expect(selected.fileName).toBe("notes.txt");
    expect(selected.mimeType).toBe("text/plain");
    expect(await selected.readBytes()).toEqual(new Uint8Array([104, 101, 108, 108, 111]));

    const typeless = selectedFileFromWebFile(new File(["hello"], "notes.txt"));
    expect(typeless.mimeType).toBe("application/octet-stream");
  });

  it("takes the base name of desktop paths", () => {
    expect(selectedFileFromDesktopPath("/Users/alice/notes/readme.txt").fileName).toBe(
      "readme.txt",
    );
    expect(selectedFileFromDesktopPath("C:\\Users\\alice\\config.json").fileName).toBe(
      "config.json",
    );
    expect(selectedFileFromDesktopPath("C:\\Users\\alice\\screen.png").mimeType).toBe("image/png");
  });
});
