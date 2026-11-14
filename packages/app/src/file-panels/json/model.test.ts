import { describe, expect, it } from "vitest";
import {
  initiallyOpen,
  isJsonLinesPath,
  parseJsonDocument,
  stripJsonExtensions,
  visibleJsonRows,
} from "./model";

describe("parseJsonDocument", () => {
  it("reads comments and trailing commas like tsconfig.json", () => {
    const text = '{\n  // compiler\n  "a": [1, 2,], /* b */ "url": "http://x//y",\n}';
    expect(parseJsonDocument(text, false)).toEqual({
      status: "ok",
      root: { a: [1, 2], url: "http://x//y" },
    });
  });

  it("keeps a comma inside a string", () => {
    expect(stripJsonExtensions('["a,]"]')).toBe('["a,]"]');
  });

  it("reports the line of a syntax error", () => {
    const result = parseJsonDocument('{\n  "a": 1\n  "b": 2\n}', false);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.line).toBe(3);
  });

  it("keys JSON Lines by line number and names the bad line", () => {
    expect(parseJsonDocument('{"a":1}\n\n{"b":2}\n', true)).toEqual({
      status: "ok",
      root: { "1": { a: 1 }, "3": { b: 2 } },
    });
    expect(parseJsonDocument('{"a":1}\n{oops}\n', true)).toMatchObject({
      status: "error",
      line: 2,
    });
    expect(isJsonLinesPath("logs/run.JSONL")).toBe(true);
    expect(isJsonLinesPath("package.json")).toBe(false);
  });
});

describe("visibleJsonRows", () => {
  const root = { name: "paseo", deps: { a: "1", "b/c": "2" }, list: [true, null] };

  it("shows the root's entries and the entries of open containers", () => {
    const rows = visibleJsonRows(root, new Set(["/deps"]));
    expect(rows.map((row) => [row.depth, row.key, row.size])).toEqual([
      [0, "name", null],
      [0, "deps", 2],
      [1, "a", null],
      [1, "b/c", null],
      [0, "list", 2],
    ]);
    expect(rows[3].id).toBe("/deps/b~1c");
  });

  it("shows a root that is not a container as one row", () => {
    expect(visibleJsonRows(42, new Set())).toEqual([
      { id: "", depth: 0, key: null, value: 42, size: null },
    ]);
  });
});

describe("initiallyOpen", () => {
  it("opens every container of a small document", () => {
    expect(initiallyOpen({ a: { b: [1] }, c: [] })).toEqual(new Set(["/a", "/a/b", "/c"]));
  });

  it("opens nothing in a large document", () => {
    const big = { items: Array.from({ length: 2000 }, (_, index) => ({ index })) };
    expect(initiallyOpen(big).size).toBe(0);
  });
});
