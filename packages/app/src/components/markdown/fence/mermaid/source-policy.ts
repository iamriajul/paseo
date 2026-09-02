// Mermaid can fetch external resources while *rendering* — image shapes
// (`A@{ img: "url" }`) construct an Image and await decode before any output
// sanitization runs, and CSS can pull url()/@import — so a prompt-injected
// diagram could exfiltrate data in a request URL. securityLevel "strict" does
// not prevent this (mermaid-js/mermaid#7645). Mermaid 11.16 parses the shape
// metadata object with yaml.JSON_SCHEMA semantics, including aliases and
// explicit keys; matching those keys safely would require a real parser. We
// therefore reject any `@{ ... }` shape-data construct up front and fall back
// to the source code block. Formatting-only `<br>` and `<i>` tags are common
// in generated labels and carry no resource-bearing attributes; all other
// tags (and entity-encoded text that could smuggle one) are rejected.
const UNSAFE_MERMAID_SOURCE =
  /@\s*\{|\burl\s*\(|@import\b|themeCSS|&#|<(?!\/?(?:br|i)\s*\/?>)[a-z!/]/i;

// A literal `<placeholder>` in prose (e.g. "<canonical URL>", "<name>") is byte-for-byte
// indistinguishable from a real tag by shape alone, so the check above can't tell them
// apart — it has to treat both as unsafe. Rather than discard the whole diagram over a
// single harmless placeholder, swap just the opening `<` for a lookalike (U+2039) before
// rendering. No literal `<` survives, so nothing here can ever be interpreted as a tag by
// Mermaid's SVG output or anything downstream — at least as safe as rejecting outright,
// without losing the rest of the diagram. Matches on the raw, undecoded source only, so
// escape-disguised tags (`<img`) still fall through to containsUnsafeMermaidSource's
// decode-and-reject path below, unchanged.
const COMPLETE_ALLOWED_TAG = /^<\/?(?:br|i)\s*\/?>/i;
const STREAMING_ALLOWED_TAG_PREFIX = /^<\/?(?:br|i|b)?\s*\/?$/i;

export function neutralizeDisallowedTags(code: string): string {
  return code.replace(/<(?=[a-z!/])/gi, (match, offset: number) => {
    const rest = code.slice(offset);
    if (COMPLETE_ALLOWED_TAG.test(rest) || STREAMING_ALLOWED_TAG_PREFIX.test(rest)) {
      return match;
    }
    return "‹";
  });
}

// Mermaid labels can contain escaped text. Decode the escape forms we care
// about before running the denylist so disguised HTML still gets caught.
// Invalid escape sequences fail closed and fall back to the source block.
function normalizeMermaidSource(code: string): string | null {
  try {
    return code
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex: string) =>
        decodeCodePointEscape(Number.parseInt(hex, 16)),
      )
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/["'`\\]/g, "");
  } catch {
    return null;
  }
}

function decodeCodePointEscape(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    throw new RangeError("Invalid Unicode code point");
  }
  return String.fromCodePoint(value);
}

// Mock-provider streaming splits long tokens into 4-char slices, so a label like
// `Done["<i>Done</i>"]` is revealed as `["<i` then `>Don` then `e</i`. The complete
// `<i>` open is allowed by UNSAFE_MERMAID_SOURCE, but the mermaid string is still
// unclosed — rendering it would let mermaid.draw steal node ids from the previous
// SVG in the same iframe document. Keep the previous diagram until the italic
// tags pair up.
function hasUnclosedItalicTags(code: string): boolean {
  const opens = code.match(/<i\s*\/?>/gi)?.length ?? 0;
  const closes = code.match(/<\/i\s*>/gi)?.length ?? 0;
  return opens > closes;
}

export function containsUnsafeMermaidSource(code: string): boolean {
  if (UNSAFE_MERMAID_SOURCE.test(code) || hasUnclosedItalicTags(code)) {
    return true;
  }
  const normalized = normalizeMermaidSource(code);
  if (normalized === null) {
    return true;
  }
  return UNSAFE_MERMAID_SOURCE.test(normalized) || hasUnclosedItalicTags(normalized);
}
