import type { ComposerAttachment, ComposerQuote } from "@/attachments/types";
import type { QuoteText } from "@/quotes/quote-format";

export function collectComposerQuotes(attachments: readonly ComposerAttachment[]): QuoteText[] {
  const quotes: QuoteText[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "quote") {
      quotes.push({ origin: attachment.quote.origin, text: attachment.quote.text });
    }
  }
  return quotes;
}

/** Appends a quote in the order added; quoting the same passage twice keeps one card. */
export function appendComposerQuote<T extends ComposerAttachment>(
  attachments: readonly T[],
  quote: ComposerQuote,
): Array<T | { kind: "quote"; quote: ComposerQuote }> {
  const duplicate = attachments.some(
    (attachment) =>
      attachment.kind === "quote" &&
      attachment.quote.origin === quote.origin &&
      attachment.quote.text === quote.text,
  );
  return duplicate ? [...attachments] : [...attachments, { kind: "quote", quote }];
}
