import { describe, expect, it } from "vitest";
import { isMermaidFenceLanguage, splitMermaidFences } from "./segments";

describe("mermaid fence aliases", () => {
  it.each(["mermaid", "mmd", "mermaid-js", "MermaidJS"])("treats %s as a diagram fence", (lang) => {
    expect(isMermaidFenceLanguage(lang)).toBe(true);
  });

  it("keeps other fences as code", () => {
    expect(isMermaidFenceLanguage("ts")).toBe(false);
    expect(isMermaidFenceLanguage(null)).toBe(false);
  });

  it("splits an mmd fence out of the surrounding markdown", () => {
    const segments = splitMermaidFences("Intro\n\n```mmd\ngraph TD\nA-->B\n```\n\nOutro\n");
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "mermaid", "markdown"]);
    expect(segments[1]?.source).toBe("graph TD\nA-->B");
  });
});
