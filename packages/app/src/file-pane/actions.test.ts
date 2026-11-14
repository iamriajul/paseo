import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { findChangedFile, workspaceRelativePath } from "./actions";

function diffFile(path: string, patch: Partial<ParsedDiffFile> = {}): ParsedDiffFile {
  return { path, isNew: false, isDeleted: false, additions: 1, deletions: 0, hunks: [], ...patch };
}

describe("workspaceRelativePath", () => {
  it("keeps a workspace path and drops a leading ./", () => {
    expect(workspaceRelativePath("src/a.ts", "/repo")).toBe("src/a.ts");
    expect(workspaceRelativePath("./src/a.ts", "/repo")).toBe("src/a.ts");
  });

  it("makes an absolute path inside the workspace relative to it", () => {
    expect(workspaceRelativePath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(workspaceRelativePath("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
    expect(workspaceRelativePath("C:\\repo\\src\\a.ts", "C:\\repo")).toBe("src/a.ts");
  });

  it("has no workspace path for a file outside the workspace", () => {
    expect(workspaceRelativePath("/repository/a.ts", "/repo")).toBeNull();
    expect(workspaceRelativePath("/tmp/a.ts", "/repo")).toBeNull();
  });
});

describe("findChangedFile", () => {
  it("finds the file Changes lists at that path", () => {
    const files = [diffFile("a.ts"), diffFile("src/b.ts", { additions: 3, deletions: 2 })];
    expect(findChangedFile(files, "src/b.ts")).toMatchObject({ additions: 3, deletions: 2 });
  });

  it("finds nothing for an unchanged file or a deleted one", () => {
    const files = [diffFile("a.ts"), diffFile("gone.ts", { isDeleted: true })];
    expect(findChangedFile(files, "b.ts")).toBeNull();
    expect(findChangedFile(files, "gone.ts")).toBeNull();
  });
});
