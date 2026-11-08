import { describe, expect, it } from "vitest";
import {
  defaultFilesViewMode,
  folderName,
  isPathInsideFolder,
  parentFolder,
  selectSubagentFolders,
} from "./model";

function file(name: string) {
  return { name, kind: "file" as const };
}

describe("defaultFilesViewMode", () => {
  it("opens an image-heavy folder as a grid", () => {
    expect(
      defaultFilesViewMode([
        file("a.png"),
        file("b.webp"),
        file("c.JPG"),
        file("d.gif"),
        file("e.bmp"),
        file("f.jpeg"),
        file("g.png"),
        file("notes.md"),
        file("h.png"),
        { name: "raw", kind: "directory" },
      ]),
    ).toBe("grid");
  });

  it("keeps a code folder, a mixed folder, and an empty folder as a list", () => {
    expect(defaultFilesViewMode([file("index.ts"), file("logo.png")])).toBe("list");
    expect(
      defaultFilesViewMode([file("a.png"), file("b.png"), file("report.md"), file("log.txt")]),
    ).toBe("list");
    expect(defaultFilesViewMode([])).toBe("list");
    expect(defaultFilesViewMode([file("diagram.svg"), file("icon.svg")])).toBe("list");
  });
});

describe("folder paths", () => {
  it("names, nests, and finds parents", () => {
    expect(folderName("/tmp/qa/shots/")).toBe("shots");
    expect(folderName("/")).toBe("/");
    expect(isPathInsideFolder("/repo/src/a.ts", "/repo")).toBe(true);
    expect(isPathInsideFolder("/repository", "/repo")).toBe(false);
    expect(parentFolder("/tmp/shots/a.png")).toBe("/tmp/shots");
    expect(parentFolder("~/shots/a.png")).toBe("~/shots");
    expect(parentFolder("/a.png")).toBe("/");
    expect(parentFolder("src/a.png")).toBeNull();
  });
});

describe("selectSubagentFolders", () => {
  const base = { title: null, archivedAt: null, workspaceId: undefined };
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 8, 12, minute));

  it("lists subagent directories at any depth, newest activity first, one row per directory", () => {
    const folders = selectSubagentFolders({
      workspaceId: "ws",
      workspaceRoot: "/repo",
      agents: [
        {
          ...base,
          id: "root",
          cwd: "/repo",
          workspaceId: "ws",
          parentAgentId: null,
          lastActivityAt: at(0),
        },
        {
          ...base,
          id: "qa",
          title: "QA run",
          cwd: "/wt/qa",
          parentAgentId: "root",
          lastActivityAt: at(5),
        },
        {
          ...base,
          id: "qa-2",
          title: "QA again",
          cwd: "/wt/qa/",
          parentAgentId: "root",
          lastActivityAt: at(9),
        },
        {
          ...base,
          id: "deep",
          title: "Nested",
          cwd: "/wt/deep",
          parentAgentId: "qa",
          lastActivityAt: at(7),
        },
        { ...base, id: "same", cwd: "/repo", parentAgentId: "root", lastActivityAt: at(8) },
        {
          ...base,
          id: "gone",
          cwd: "/wt/gone",
          parentAgentId: "root",
          lastActivityAt: at(9),
          archivedAt: at(9),
        },
        {
          ...base,
          id: "other-root",
          cwd: "/other",
          workspaceId: "ws-2",
          parentAgentId: null,
          lastActivityAt: at(1),
        },
        {
          ...base,
          id: "other",
          cwd: "/wt/other",
          parentAgentId: "other-root",
          lastActivityAt: at(9),
        },
      ],
    });
    expect(folders.map((folder) => [folder.title, folder.cwd])).toEqual([
      ["QA again", "/wt/qa/"],
      ["Nested", "/wt/deep"],
    ]);
  });
});
