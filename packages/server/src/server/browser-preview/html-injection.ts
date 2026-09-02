// Bounds how much of a response is held in memory looking for an injection
// point. Past it the body streams unmodified: a document whose <head> has not
// closed inside 64 KiB is not one worth delaying.
export const INJECTION_SCAN_LIMIT_BYTES = 65536;

// Matches <meta http-equiv="content-security-policy"> and its report-only
// variant, in either attribute order and with any quoting style. The proxy
// strips the response header elsewhere; a meta tag survives that and would
// block the injected bridge.
const META_CSP_PATTERN =
  /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy(?:-report-only)?["']?)[^>]*>/gi;

function offsetAfterOpenTag(html: string, tagName: string): number | null {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const match = pattern.exec(html);
  if (match === null) return null;
  return match.index + match[0].length;
}

// Returns a string index, not a byte count; callers slice the same string.
export function findHeadInjectionOffset(html: string): number {
  // Nothing may precede the doctype: a node before it puts the whole document
  // into quirks mode, which changes the layout of the page we are previewing.
  // Locating it first and searching only what follows makes that structural —
  // a comment before the doctype holding a literal <head> cannot pull the
  // offset back in front of it.
  const doctype = /<!doctype\b[^>]*>/i.exec(html);
  const searchFrom = doctype === null ? 0 : doctype.index + doctype[0].length;
  const rest = html.slice(searchFrom);

  const head = offsetAfterOpenTag(rest, "head");
  if (head !== null) return searchFrom + head;

  const htmlTag = offsetAfterOpenTag(rest, "html");
  if (htmlTag !== null) return searchFrom + htmlTag;

  return searchFrom;
}

export function stripMetaCsp(html: string): string {
  return html.replace(META_CSP_PATTERN, "");
}

export function rewriteHtmlHead(windowText: string, scripts: string): string {
  const stripped = stripMetaCsp(windowText);
  const offset = findHeadInjectionOffset(stripped);
  return stripped.slice(0, offset) + scripts + stripped.slice(offset);
}
