import { describe, expect, it } from "vitest";
import {
  parseQuotedPrompt,
  QUOTE_HEADERS,
  QUOTE_MAX_CHARS,
  serializeQuotedPrompt,
} from "./quote-format";

describe("serializeQuotedPrompt", () => {
  it("writes the documented shape for one quote", () => {
    expect(
      serializeQuotedPrompt({
        quotes: [{ origin: "assistant", text: "The old session keys are discarded on purpose." }],
        text: "Why discard them instead of rotating?",
      }),
    ).toBe(
      "> [Quoted from your earlier reply]\n" +
        "> The old session keys are discarded on purpose.\n\n" +
        "Why discard them instead of rotating?",
    );
  });

  it("returns the typed text untouched when there are no quotes", () => {
    expect(serializeQuotedPrompt({ quotes: [], text: "plain" })).toBe("plain");
  });

  it("allows a prompt that is quotes alone", () => {
    expect(serializeQuotedPrompt({ quotes: [{ origin: "user", text: "do X" }], text: "" })).toBe(
      "> [Quoted from my earlier message]\n> do X",
    );
  });

  it("uses the third header for a side question answer", () => {
    const out = serializeQuotedPrompt({
      quotes: [{ origin: "side_question", text: "answer" }],
      text: "go",
    });
    expect(out.startsWith(`> ${QUOTE_HEADERS.side_question}\n`)).toBe(true);
  });

  it("keeps the head and tail of a long same-conversation quote around a […] line", () => {
    const text = `${"a".repeat(3000)}${"b".repeat(3000)}`;
    const out = serializeQuotedPrompt({ quotes: [{ origin: "assistant", text }], text: "" });
    expect(out).toContain("\n> […]\n");
    expect(out.length).toBeLessThan(QUOTE_MAX_CHARS + 200);
    expect(out).toContain("a".repeat(100));
    expect(out).toContain("b".repeat(100));
  });

  it("sends a side question quote whole", () => {
    const text = "x".repeat(QUOTE_MAX_CHARS * 2);
    const out = serializeQuotedPrompt({ quotes: [{ origin: "side_question", text }], text: "" });
    expect(out).toContain(text);
    expect(out).not.toContain("[…]");
  });
});

describe("parseQuotedPrompt", () => {
  it("round-trips several quotes, blank lines inside a quote, and typed text", () => {
    const quotes = [
      { origin: "assistant" as const, text: "line one\n\nline three" },
      { origin: "user" as const, text: "mine" },
      { origin: "side_question" as const, text: "aside" },
    ];
    const text = "What now?\n\n> a user-written quote line";
    const parsed = parseQuotedPrompt(serializeQuotedPrompt({ quotes, text }));
    expect(parsed).toEqual({ quotes, text });
  });

  it("round-trips quotes alone", () => {
    const quotes = [{ origin: "assistant" as const, text: "just this" }];
    expect(parseQuotedPrompt(serializeQuotedPrompt({ quotes, text: "" }))).toEqual({
      quotes,
      text: "",
    });
  });

  it("leaves a message with no quote header as text", () => {
    const text = "> not a paseo quote\n> still not";
    expect(parseQuotedPrompt(text)).toEqual({ quotes: [], text });
  });

  it("stops at the first block that is not a quote", () => {
    const first = serializeQuotedPrompt({
      quotes: [{ origin: "assistant", text: "q" }],
      text: "> [Quoted from somebody else]\n> hi",
    });
    const parsed = parseQuotedPrompt(first);
    expect(parsed.quotes).toHaveLength(1);
    expect(parsed.text).toBe("> [Quoted from somebody else]\n> hi");
  });
});
