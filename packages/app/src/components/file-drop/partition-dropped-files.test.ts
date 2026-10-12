import { describe, expect, it } from "vitest";
import { partitionDroppedFiles } from "./partition-dropped-files";

function fileItem(name: string, isDirectory: boolean): DataTransferItem {
  return {
    kind: "file",
    type: "",
    webkitGetAsEntry: () => ({ isDirectory, name }) as FileSystemEntry,
  } as DataTransferItem;
}

function itemList(items: DataTransferItem[]): DataTransferItemList {
  return {
    length: items.length,
    ...Object.fromEntries(items.map((item, index) => [index, item])),
  } as DataTransferItemList;
}

describe("partition dropped files", () => {
  it("removes dropped folders reported through the items API", () => {
    const folder = new File([], "assets");
    const note = new File(["hi"], "note.txt", { type: "text/plain" });
    const items = itemList([fileItem("assets", true), fileItem("note.txt", false)]);

    const partitioned = partitionDroppedFiles([folder, note], items);

    expect(partitioned.files).toEqual([note]);
    expect(partitioned.skippedDirectoryCount).toBe(1);
  });

  it("keeps empty files that are not folders", () => {
    const empty = new File([], "empty.txt");
    const items = itemList([fileItem("empty.txt", false)]);

    const partitioned = partitionDroppedFiles([empty], items);

    expect(partitioned.files).toEqual([empty]);
    expect(partitioned.skippedDirectoryCount).toBe(0);
  });

  it("passes files through when items are unavailable", () => {
    const note = new File(["hi"], "note.txt", { type: "text/plain" });

    expect(partitionDroppedFiles([note], null)).toEqual({
      files: [note],
      skippedDirectoryCount: 0,
    });
    expect(partitionDroppedFiles([note], itemList([]))).toEqual({
      files: [note],
      skippedDirectoryCount: 0,
    });
  });
});
