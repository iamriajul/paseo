import { describe, expect, it } from "vitest";
import type { ComposerQuote, UserComposerAttachment } from "@/attachments/types";
import { UserComposerAttachmentSchema } from "@/stores/draft-store/state";
import { appendComposerQuote, collectComposerQuotes } from "./composer-quotes";

function quote(
  id: string,
  text: string,
  origin: ComposerQuote["origin"] = "assistant",
): ComposerQuote {
  return { id, origin, text, partial: false };
}

describe("appendComposerQuote", () => {
  it("adds quotes in the order they were added", () => {
    const first = appendComposerQuote([], quote("a", "one"));
    const second = appendComposerQuote(first, quote("b", "two"));
    expect(collectComposerQuotes(second)).toEqual([
      { origin: "assistant", text: "one" },
      { origin: "assistant", text: "two" },
    ]);
  });

  it("keeps one card when the same passage is quoted twice", () => {
    const once = appendComposerQuote([], quote("a", "same"));
    expect(appendComposerQuote(once, quote("b", "same"))).toHaveLength(1);
  });

  it("treats the same text from another origin as a different quote", () => {
    const once = appendComposerQuote([], quote("a", "same"));
    expect(appendComposerQuote(once, quote("b", "same", "side_question"))).toHaveLength(2);
  });

  it("leaves other attachments where they are", () => {
    const file: UserComposerAttachment = {
      kind: "workspace_file",
      path: "README.md",
      selection: { kind: "whole_file" },
    };
    const next = appendComposerQuote([file], quote("a", "one"));
    expect(next[0]).toBe(file);
    expect(collectComposerQuotes(next)).toEqual([{ origin: "assistant", text: "one" }]);
  });
});

describe("a quote in a persisted draft", () => {
  it("survives the draft store's schema, so it stays with the draft", () => {
    const attachment: UserComposerAttachment = {
      kind: "quote",
      quote: { id: "q", origin: "user", text: "mine", partial: true, messageId: "m1" },
    };
    expect(UserComposerAttachmentSchema.parse(attachment)).toEqual(attachment);
  });

  it("rejects a quote from an origin the wire format does not know", () => {
    expect(
      UserComposerAttachmentSchema.safeParse({
        kind: "quote",
        quote: { id: "q", origin: "system", text: "x", partial: false },
      }).success,
    ).toBe(false);
  });
});
