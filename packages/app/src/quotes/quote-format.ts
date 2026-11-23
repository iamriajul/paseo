/**
 * Wire format for quotes. A quote travels as plain prompt text ahead of what the user typed, so it
 * survives every provider's history rehydration and needs no protocol change. The three header
 * strings are read by the agent: keep them out of i18n.
 * See docs/quotes-and-side-questions.md.
 */

export type QuoteOrigin = "assistant" | "user" | "side_question";

export const QUOTE_HEADERS: Record<QuoteOrigin, string> = {
  assistant: "[Quoted from your earlier reply]",
  user: "[Quoted from my earlier message]",
  side_question:
    "[Quoted from your answer to a side question. That exchange is not in this conversation.]",
};

/** A quote from the same conversation keeps this many characters; the agent holds the rest. */
export const QUOTE_MAX_CHARS = 4000;
const QUOTE_ELISION = "[…]";

export interface QuoteText {
  origin: QuoteOrigin;
  text: string;
}

function trimQuoteForWire(quote: QuoteText): string {
  const text = quote.text.replace(/\r\n?/g, "\n").trim();
  if (quote.origin === "side_question" || text.length <= QUOTE_MAX_CHARS) {
    return text;
  }
  const half = Math.floor(QUOTE_MAX_CHARS / 2);
  return `${text.slice(0, half).trimEnd()}\n${QUOTE_ELISION}\n${text.slice(-half).trimStart()}`;
}

function quoteLine(line: string): string {
  return line.length > 0 ? `> ${line}` : ">";
}

export function serializeQuote(quote: QuoteText): string {
  const body = trimQuoteForWire(quote);
  return [QUOTE_HEADERS[quote.origin], ...body.split("\n")].map(quoteLine).join("\n");
}

/** The prompt text the agent receives: every quote block, then what the user typed. */
export function serializeQuotedPrompt(input: {
  quotes: readonly QuoteText[];
  text: string;
}): string {
  const blocks = input.quotes
    .filter((quote) => quote.text.trim().length > 0)
    .map((quote) => serializeQuote(quote));
  if (blocks.length === 0) {
    return input.text;
  }
  const typed = input.text.trim().length > 0 ? input.text : "";
  return typed ? `${blocks.join("\n\n")}\n\n${typed}` : blocks.join("\n\n");
}

const ORIGIN_BY_HEADER = new Map<string, QuoteOrigin>(
  (Object.keys(QUOTE_HEADERS) as QuoteOrigin[]).map((origin) => [QUOTE_HEADERS[origin], origin]),
);

function unquoteLine(line: string): string | null {
  if (line === ">") return "";
  if (line.startsWith("> ")) return line.slice(2);
  return null;
}

export interface ParsedQuotedPrompt {
  quotes: QuoteText[];
  /** What follows the quote blocks. The whole text when it holds none. */
  text: string;
}

/**
 * Reads leading blocks of the exact shape `serializeQuotedPrompt` writes back into quotes. Stops
 * at the first block that is not one of them, so a user's own `>` lines stay text.
 */
export function parseQuotedPrompt(prompt: string): ParsedQuotedPrompt {
  const lines = prompt.replace(/\r\n?/g, "\n").split("\n");
  const quotes: QuoteText[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = unquoteLine(lines[index] ?? "");
    const origin = header === null ? undefined : ORIGIN_BY_HEADER.get(header);
    if (!origin) break;
    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const content = unquoteLine(lines[cursor] ?? "");
      if (content === null) break;
      body.push(content);
      cursor += 1;
    }
    if (body.length === 0) break;
    quotes.push({ origin, text: body.join("\n") });
    index = cursor;
    // One blank line separates blocks, and the last block from the typed text.
    if (lines[index] === "") index += 1;
  }
  if (quotes.length === 0) {
    return { quotes: [], text: prompt };
  }
  return { quotes, text: lines.slice(index).join("\n") };
}
