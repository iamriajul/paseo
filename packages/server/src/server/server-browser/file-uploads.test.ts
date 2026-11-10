import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, removeUploads, writeUploads } from "./file-uploads.js";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("file uploads", () => {
  it("keeps each file's own name inside the tab's folder, never a path out of it", async () => {
    root = mkdtempSync(join(tmpdir(), "server-browser-uploads-"));
    const data = Buffer.from("hello").toString("base64");
    const paths = await writeUploads(root, "tab-1", [
      { name: "../../evil.txt", dataBase64: data },
      { name: "C:\\Users\\me\\notes.txt", dataBase64: data },
      { name: "notes.txt", dataBase64: data },
      { name: "..", dataBase64: data },
    ]);
    expect(paths.map((path) => path.slice(dirname(path).length + 1))).toEqual([
      "evil.txt",
      "notes.txt",
      "2-notes.txt",
      "file",
    ]);
    for (const path of paths) {
      expect(path.startsWith(join(root, "tab-1"))).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("hello");
    }
    await removeUploads(root, "tab-1");
    expect(existsSync(join(root, "tab-1"))).toBe(false);
  });

  it("refuses more than an upload can carry", async () => {
    root = mkdtempSync(join(tmpdir(), "server-browser-uploads-"));
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64");
    await expect(
      writeUploads(root, "tab-1", [{ name: "big.bin", dataBase64: big }]),
    ).rejects.toThrow(/up to 50 MB/);
  });
});
