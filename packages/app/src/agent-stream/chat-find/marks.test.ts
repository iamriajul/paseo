import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import type { ASTNode } from "react-native-enriched-markdown/src/web/types";
import { describe, expect, it } from "vitest";
import { prepareMarkdownSource } from "@/components/markdown/source";
import { findSourceMatches, markMarkdownMatch, splitPlainMatch } from "./marks";

const mark = (query: string, occurrence = 0) => ({ query, occurrence });

describe("findSourceMatches", () => {
  it("counts case-insensitive occurrences and lets query whitespace span line breaks", () => {
    expect(findSourceMatches("Needle and needle\nNEEDLE", "needle")).toHaveLength(3);
    expect(findSourceMatches("two\nwords", "two words")).toEqual([{ start: 0, end: 9 }]);
    expect(findSourceMatches("anything", "   ")).toEqual([]);
  });

  it("treats regex syntax in the query as text", () => {
    expect(findSourceMatches("a.b axb", "a.b")).toEqual([{ start: 0, end: 3 }]);
  });
});

describe("splitPlainMatch", () => {
  it("splits a prompt around the selected occurrence", () => {
    expect(splitPlainMatch("find needle, then needle", mark("needle", 1))).toEqual({
      before: "find needle, then ",
      match: "needle",
      after: "",
    });
    expect(splitPlainMatch("no match", mark("needle"))).toBeNull();
  });
});

describe("markMarkdownMatch", () => {
  it("wraps the selected occurrence in prose and leaves the others alone", () => {
    expect(markMarkdownMatch("a needle, **a needle**", mark("needle", 1))).toEqual({
      text: "a needle, **a ==needle==**",
      marked: true,
    });
  });

  it("marks the whole inline code span that holds the occurrence", () => {
    expect(markMarkdownMatch("call `find_needle()` now", mark("needle"))).toEqual({
      text: "call ==`find_needle()`== now",
      marked: true,
    });
  });

  it("does not mark inside a fenced block, where the delimiters would print", () => {
    const source = "intro\n\n```ts\nconst needle = 1;\n```\n\nneedle after";
    expect(markMarkdownMatch(source, mark("needle", 0))).toEqual({ text: source, marked: false });
    expect(markMarkdownMatch(source, mark("needle", 1)).text).toBe(
      "intro\n\n```ts\nconst needle = 1;\n```\n\n==needle== after",
    );
  });

  it("does not mark a link target, a bare URL or a match that crosses Markdown syntax", () => {
    for (const source of [
      "[docs](https://example.com/needle)",
      "see https://example.com/needle",
      "a nee**dle** b",
    ]) {
      const query = source.includes("**") ? "nee**dle" : "needle";
      expect(markMarkdownMatch(source, mark(query))).toEqual({ text: source, marked: false });
    }
  });

  it("escapes the author's own == so only the occurrence is highlighted", () => {
    expect(markMarkdownMatch("if a==b and c==d, needle", mark("needle")).text).toBe(
      "if a\\=\\=b and c\\=\\=d, ==needle==",
    );
  });

  it("keeps == inside code and a setext underline as written", () => {
    expect(markMarkdownMatch("Title\n=====\n\n`a==b` needle", mark("needle")).text).toBe(
      "Title\n=====\n\n`a==b` ==needle==",
    );
  });

  it("returns the source untouched when the occurrence is gone", () => {
    expect(markMarkdownMatch("nothing here", mark("needle"))).toEqual({
      text: "nothing here",
      marked: false,
    });
  });
});

// The mark is Markdown syntax, so what proves it is the renderer's own parser, after the
// source adaptation every message goes through.
describe("a marked message through the renderer's parser", () => {
  async function highlighted(source: string, query: string, occurrence = 0) {
    const { text, marked } = markMarkdownMatch(source, mark(query, occurrence));
    const tree = await parseMarkdown(prepareMarkdownSource(text).render(), {
      hardSoftBreaks: true,
      latexMath: false,
      highlight: marked,
    });
    const found: string[] = [];
    const textOf = (node: ASTNode): string =>
      (node.content ?? "") + (node.children ?? []).map(textOf).join("");
    const collect = (node: ASTNode) => {
      if (node.type === "Highlight") found.push(textOf(node));
      node.children?.forEach(collect);
    };
    collect(tree);
    return { found, rendered: textOf(tree) };
  }

  it("highlights only the occurrence, in prose, inside a word and inside emphasis", async () => {
    expect((await highlighted("a needle, **a needle**", "needle", 1)).found).toEqual(["needle"]);
    expect((await highlighted("the haystackneedlehay", "needle")).found).toEqual(["needle"]);
    expect((await highlighted("- item with needle\n- other", "needle")).found).toEqual(["needle"]);
  });

  it("highlights the inline code span that holds the occurrence", async () => {
    expect((await highlighted("call `find_needle()` now", "needle")).found).toEqual([
      "find_needle()",
    ]);
  });

  it("leaves the author's == as text", async () => {
    const result = await highlighted("if a==b and c==d, needle", "needle");
    expect(result.found).toEqual(["needle"]);
    expect(result.rendered).toContain("a==b and c==d");
  });

  it("renders an unmarkable message exactly as before", async () => {
    const result = await highlighted("```ts\nconst needle = 1;\n```", "needle");
    expect(result.found).toEqual([]);
    expect(result.rendered).toContain("const needle = 1;");
  });
});
