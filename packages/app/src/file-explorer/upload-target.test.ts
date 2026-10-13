import { describe, expect, it } from "vitest";
import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import {
  findBatchDuplicateNames,
  findExplorerEntryByPath,
  findUploadConflicts,
  formatUploadConflictNames,
  resolveUploadParentPath,
  uploadSingleFile,
} from "./upload-target";

function makeEntry(name: string, path: string, kind: ExplorerEntry["kind"]): ExplorerEntry {
  return { name, path, kind, size: 0, modifiedAt: "2026-01-01T00:00:00.000Z" };
}

function makeDirectories(): Map<string, ExplorerDirectory> {
  return new Map([
    [
      ".",
      {
        path: ".",
        entries: [
          makeEntry("notes.txt", "notes.txt", "file"),
          makeEntry("docs", "docs", "directory"),
        ],
      },
    ],
    [
      "docs",
      {
        path: "docs",
        entries: [makeEntry("guide.md", "docs/guide.md", "file")],
      },
    ],
  ]);
}

describe("upload target", () => {
  it("uploads to the selected folder, a file's parent, or the root", () => {
    expect(resolveUploadParentPath(null)).toBe(".");
    expect(resolveUploadParentPath(makeEntry("docs", "docs", "directory"))).toBe("docs");
    expect(resolveUploadParentPath(makeEntry("guide.md", "docs/guide.md", "file"))).toBe("docs");
    expect(resolveUploadParentPath(makeEntry("notes.txt", "notes.txt", "file"))).toBe(".");
  });

  it("finds entries across listed directories", () => {
    const directories = makeDirectories();
    expect(findExplorerEntryByPath(directories, "docs/guide.md")).toEqual(
      makeEntry("guide.md", "docs/guide.md", "file"),
    );
    expect(findExplorerEntryByPath(directories, "missing.txt")).toBeNull();
  });

  it("reports names that already exist as files in the target folder", () => {
    const directories = makeDirectories();
    expect(
      findUploadConflicts({
        parentPath: ".",
        fileNames: ["notes.txt", "fresh.txt"],
        directories,
      }),
    ).toEqual(["notes.txt"]);
    expect(
      findUploadConflicts({
        parentPath: "docs",
        fileNames: ["notes.txt"],
        directories,
      }),
    ).toEqual([]);
    expect(
      findUploadConflicts({
        parentPath: ".",
        fileNames: ["docs"],
        directories,
      }),
    ).toEqual([]);
  });

  it("matches case-insensitively and compares trimmed names", () => {
    const directories = makeDirectories();
    expect(
      findUploadConflicts({
        parentPath: "docs",
        fileNames: ["GUIDE.md"],
        directories,
      }),
    ).toEqual(["GUIDE.md"]);
    expect(
      findUploadConflicts({
        parentPath: ".",
        fileNames: ["  notes.txt  "],
        directories,
      }),
    ).toEqual(["notes.txt"]);
  });

  it("fails closed when the target folder has no listing", () => {
    const directories = makeDirectories();
    expect(
      findUploadConflicts({
        parentPath: "unlisted",
        fileNames: ["notes.txt", "fresh.txt"],
        directories,
      }),
    ).toEqual(["notes.txt", "fresh.txt"]);
  });

  it("reports names repeated within one batch", () => {
    expect(findBatchDuplicateNames(["a.txt", "b.txt"])).toEqual([]);
    expect(findBatchDuplicateNames(["a.txt", "b.txt", "a.txt"])).toEqual(["a.txt"]);
    expect(findBatchDuplicateNames(["a.txt", "  A.TXT "])).toEqual(["A.TXT"]);
    expect(findBatchDuplicateNames(["   "])).toEqual([]);
  });

  it("formats conflict names with a cap", () => {
    expect(formatUploadConflictNames(["a.txt"])).toBe('"a.txt"');
    expect(formatUploadConflictNames(["a.txt", "b.txt"])).toBe('"a.txt", "b.txt"');
    expect(formatUploadConflictNames(["1", "2", "3", "4", "5", "6"])).toBe(
      '"1", "2", "3", "4", "5", …',
    );
  });

  it("retries with overwrite when confirmed and marks dismissed retry confirms as cancelled", async () => {
    const confirmedCalls: boolean[] = [];
    const confirmedOutcome = await uploadSingleFile({
      trimmedName: "race.txt",
      needsOverwrite: false,
      send: async (overwrite) => {
        confirmedCalls.push(overwrite);
        if (!overwrite) {
          return {
            success: false,
            path: null,
            error: '"race.txt" already exists',
            alreadyExists: true,
          };
        }
        return { success: true, path: "race.txt", error: null };
      },
      confirm: async (names) => {
        expect(names).toEqual(["race.txt"]);
        return true;
      },
    });
    expect(confirmedCalls).toEqual([false, true]);
    expect(confirmedOutcome).toEqual({ uploadedPath: "race.txt", error: null });

    const dismissedCalls: boolean[] = [];
    const dismissedOutcome = await uploadSingleFile({
      trimmedName: "race.txt",
      needsOverwrite: false,
      send: async (overwrite) => {
        dismissedCalls.push(overwrite);
        return {
          success: false,
          path: null,
          error: '"race.txt" already exists',
          alreadyExists: true,
        };
      },
      confirm: async () => false,
    });
    expect(dismissedCalls).toEqual([false]);
    expect(dismissedOutcome).toEqual({
      uploadedPath: null,
      error: null,
      cancelled: true,
    });
  });
});
