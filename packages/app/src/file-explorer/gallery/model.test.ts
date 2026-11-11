import { describe, expect, it } from "vitest";
import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import { resolveImageGallery, stepImageGallery } from "./model";

function entry(path: string, kind: ExplorerEntry["kind"] = "file", size = 1): ExplorerEntry {
  return { name: path.split("/").pop() ?? path, path, kind, size, modifiedAt: "" };
}

function directories(listings: Record<string, ExplorerEntry[]>) {
  return new Map<string, ExplorerDirectory>(
    Object.entries(listings).map(([path, entries]) => [path, { path, entries }]),
  );
}

const shots = directories({
  ".": [entry("shots", "directory"), entry("README.md")],
  shots: [
    entry("shots/c.png", "file", 3),
    entry("shots/notes.md"),
    entry("shots/a.webp", "file", 9),
    entry("shots/raw", "directory"),
    entry("shots/b.JPG", "file", 1),
    entry("shots/.hidden.png", "file", 2),
  ],
});

const base = {
  workspaceRoot: "/repo",
  filesRoot: "/repo",
  directories: shots,
  sortOption: "name" as const,
  showHiddenFiles: false,
};

describe("resolveImageGallery", () => {
  it("lists the folder's images in Files order, skipping other files and folders", () => {
    const gallery = resolveImageGallery({ ...base, filePath: "shots/b.JPG" });
    expect(gallery).toEqual({
      index: 1,
      items: [
        { name: "a.webp", targetPath: "shots/a.webp" },
        { name: "b.JPG", targetPath: "shots/b.JPG" },
        { name: "c.png", targetPath: "shots/c.png" },
      ],
    });
  });

  it("follows the Files sort and hidden-files setting", () => {
    const gallery = resolveImageGallery({
      ...base,
      filePath: "/repo/shots/c.png",
      sortOption: "size",
      showHiddenFiles: true,
    });
    expect(gallery?.items.map((item) => item.name)).toEqual([
      "a.webp",
      "c.png",
      ".hidden.png",
      "b.JPG",
    ]);
    expect(gallery?.index).toBe(1);
  });

  it("targets absolute paths when Files shows a folder outside the workspace", () => {
    const gallery = resolveImageGallery({
      ...base,
      filesRoot: "/tmp/evidence",
      directories: directories({ ".": [entry("one.png"), entry("two.png")] }),
      filePath: "/tmp/evidence/two.png",
    });
    expect(gallery).toEqual({
      index: 1,
      items: [
        { name: "one.png", targetPath: "/tmp/evidence/one.png" },
        { name: "two.png", targetPath: "/tmp/evidence/two.png" },
      ],
    });
  });

  it("has nothing to page to with one image, an unlisted folder, or a file outside the root", () => {
    expect(
      resolveImageGallery({
        ...base,
        directories: directories({ ".": [entry("only.png"), entry("a.md")] }),
        filePath: "only.png",
      }),
    ).toBeNull();
    expect(resolveImageGallery({ ...base, filePath: "elsewhere/a.png" })).toBeNull();
    expect(
      resolveImageGallery({ ...base, filesRoot: "/tmp/evidence", filePath: "shots/a.webp" }),
    ).toBeNull();
    expect(resolveImageGallery({ ...base, filePath: "shots/notes.md" })).toBeNull();
  });
});

describe("stepImageGallery", () => {
  it("steps within the folder and stops at either end", () => {
    const items = [
      { name: "a", targetPath: "a" },
      { name: "b", targetPath: "b" },
    ];
    expect(stepImageGallery({ items, index: 0 }, 1)).toBe(1);
    expect(stepImageGallery({ items, index: 0 }, -1)).toBeNull();
    expect(stepImageGallery({ items, index: 1 }, 1)).toBeNull();
  });
});
