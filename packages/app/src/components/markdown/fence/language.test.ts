import { describe, expect, it } from "vitest";
import { getMarkdownFenceLanguage } from "./language";

describe("getMarkdownFenceLanguage", () => {
  it("normalizes the first info-string token", () => {
    expect(getMarkdownFenceLanguage(" Sirena theme=dark ")).toBe("sirena");
    expect(getMarkdownFenceLanguage("TypeScript title=example")).toBe("typescript");
    expect(getMarkdownFenceLanguage("mmd")).toBe("mmd");
    expect(getMarkdownFenceLanguage("mermaid-js")).toBe("mermaid-js");
    expect(getMarkdownFenceLanguage("mermaidjs")).toBe("mermaidjs");
  });

  it("returns null when no language is declared", () => {
    expect(getMarkdownFenceLanguage("")).toBeNull();
    expect(getMarkdownFenceLanguage(null)).toBeNull();
    expect(getMarkdownFenceLanguage(undefined)).toBeNull();
  });
});
