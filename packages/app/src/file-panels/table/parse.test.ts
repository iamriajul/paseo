import { describe, expect, it } from "vitest";
import { layoutTable, parseDelimited, tableDelimiter } from "./parse";

describe("parseDelimited", () => {
  it("reads quoted fields with delimiters, doubled quotes and line breaks", () => {
    const text = 'name,note\r\n"Smith, Ann","said ""hi""\nthen left"\nBo,\n';
    expect(parseDelimited(text, ",")).toEqual([
      ["name", "note"],
      ["Smith, Ann", 'said "hi"\nthen left'],
      ["Bo", ""],
    ]);
  });

  it("splits TSV on tabs and keeps commas in a field", () => {
    expect(parseDelimited("a\tb\n1,5\t2\n", "\t")).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
  });

  it("skips blank lines but keeps a quoted empty field", () => {
    expect(parseDelimited('a\n\n""\nb', ",")).toEqual([["a"], [""], ["b"]]);
  });

  it("reads the rest of an unterminated quote as written", () => {
    expect(parseDelimited('a,"b,c\nd', ",")).toEqual([["a", "b,c\nd"]]);
  });
});

describe("layoutTable", () => {
  it("sizes columns by their longest value and right-aligns number columns", () => {
    const layout = layoutTable([
      ["id", "name", "price"],
      ["1", "A very long product name that keeps going on and on", "1,200.50"],
      ["2", "B", ""],
      ["3", "C", "-4e3"],
    ]);
    expect(layout.columns).toBe(3);
    expect(layout.widths).toEqual([3, 40, 8]);
    expect(layout.numeric).toEqual([true, false, true]);
  });

  it("counts the widest row's columns", () => {
    expect(layoutTable([["a"], ["b", "c", "d"]]).columns).toBe(3);
  });
});

describe("tableDelimiter", () => {
  it("reads CSV and TSV extensions", () => {
    expect(tableDelimiter("data/People.CSV")).toBe(",");
    expect(tableDelimiter("out.tsv")).toBe("\t");
    expect(tableDelimiter("notes.txt")).toBeNull();
  });
});
