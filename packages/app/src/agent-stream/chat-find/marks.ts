import { findQueryPattern } from "./query-pattern";

/** The occurrence chat find has landed on inside one message. */
export interface ChatFindMark {
  query: string;
  occurrence: number;
}

export interface SourceMatch {
  start: number;
  end: number;
}

/**
 * Occurrences in a message's source text. Native has no rendered text to walk, so its
 * count and its occurrence index are the source's, the same text the host searched.
 */
export function findSourceMatches(text: string, query: string): SourceMatch[] {
  const pattern = findQueryPattern(query);
  if (!pattern) return [];
  const matches: SourceMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

/** A plain-text message split around its marked occurrence; null when there is none. */
export function splitPlainMatch(
  text: string,
  mark: ChatFindMark,
  source: string = text,
): { before: string; match: string; after: string } | null {
  const whole = source.endsWith(text) ? source : text;
  const offset = whole.length - text.length;
  const found = findSourceMatches(whole, mark.query)[mark.occurrence];
  if (!found || found.start < offset) return null;
  const start = found.start - offset;
  const end = found.end - offset;
  return {
    before: text.slice(0, start),
    match: text.slice(start, end),
    after: text.slice(end),
  };
}

interface Region extends SourceMatch {
  /** `code` is an inline code span, which can be marked whole; the rest cannot hold a mark. */
  kind: "code" | "opaque";
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(?<!`)(`+)(?!`)([^]*?[^`])\1(?!`)/g;
const OPAQUE = /\]\([^)\n]*\)|<[^>\n]+>|https?:\/\/\S+/g;
/** Characters that open or close Markdown syntax; a mark around them could change the parse. */
const SYNTAX = /[*_`[\]|\n=<>\\~]/;

function fencedRegions(source: string): Region[] {
  const regions: Region[] = [];
  let offset = 0;
  let open: { start: number; marker: string } | null = null;
  for (const line of source.split("\n")) {
    const fence = FENCE_OPEN.exec(line)?.[1];
    if (open) {
      const closes =
        fence !== undefined &&
        fence[0] === open.marker[0] &&
        fence.length >= open.marker.length &&
        line.trim() === fence;
      if (closes) {
        regions.push({ kind: "opaque", start: open.start, end: offset + line.length });
        open = null;
      }
    } else if (fence !== undefined) {
      open = { start: offset, marker: fence };
    }
    offset += line.length + 1;
  }
  if (open) regions.push({ kind: "opaque", start: open.start, end: source.length });
  return regions;
}

function overlapsAny(regions: Region[], start: number, end: number): boolean {
  return regions.some((region) => region.start < end && start < region.end);
}

/** Regions of Markdown source whose text is literal or not rendered, in source order. */
function protectedRegions(source: string): Region[] {
  const regions = fencedRegions(source);
  const inline: Region[] = [];
  for (const match of source.matchAll(INLINE_CODE)) {
    const start = match.index;
    const end = start + match[0].length;
    // A code span never crosses a paragraph break or a fence.
    if (match[0].includes("\n\n") || overlapsAny(regions, start, end)) continue;
    inline.push({ kind: "code", start, end });
  }
  regions.push(...inline);
  for (const match of source.matchAll(OPAQUE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!overlapsAny(regions, start, end)) regions.push({ kind: "opaque", start, end });
  }
  return regions.sort((left, right) => left.start - right.start);
}

function markableRange(source: string, regions: Region[], match: SourceMatch): SourceMatch | null {
  const span = regions.find(
    (region) => region.kind === "code" && region.start <= match.start && match.end <= region.end,
  );
  const range = span ?? match;
  if (!span) {
    if (overlapsAny(regions, match.start, match.end)) return null;
    if (SYNTAX.test(source.slice(match.start, match.end))) return null;
  }
  // A delimiter run longer than two is not a highlight delimiter.
  if (source[range.start - 1] === "=" || source[range.end] === "=") return null;
  return range;
}

interface Edit {
  at: number;
  remove: number;
  insert: string;
}

/**
 * Wrap the marked occurrence in the renderer's `==highlight==` syntax, for a renderer
 * with highlight parsing turned on. `marked` is false when the occurrence sits where a
 * mark would not render (a fenced block, a link target) or would change the parse; the
 * source then comes back untouched. An occurrence inside an inline code span marks the
 * whole span. Every other `==` in prose is escaped, since turning the syntax on would
 * otherwise highlight text the author never marked.
 */
export function markMarkdownMatch(
  source: string,
  mark: ChatFindMark,
): { text: string; marked: boolean } {
  const match = findSourceMatches(source, mark.query)[mark.occurrence];
  if (!match) return { text: source, marked: false };
  const regions = protectedRegions(source);
  const range = markableRange(source, regions, match);
  if (!range) return { text: source, marked: false };
  const edits: Edit[] = [
    { at: range.start, remove: 0, insert: "==" },
    { at: range.end, remove: 0, insert: "==" },
  ];
  for (const run of source.matchAll(/={2,}/g)) {
    const start = run.index;
    const end = start + run[0].length;
    if (overlapsAny(regions, start, end)) continue;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = source.indexOf("\n", end);
    const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    // A line of only `=` underlines a setext heading; escaping it would print it.
    if (/^\s*=+\s*$/.test(line)) continue;
    edits.push({ at: start, remove: run[0].length, insert: run[0].replace(/=/g, "\\=") });
  }
  edits.sort((left, right) => right.at - left.at || right.remove - left.remove);
  let text = source;
  for (const edit of edits) {
    text = text.slice(0, edit.at) + edit.insert + text.slice(edit.at + edit.remove);
  }
  return { text, marked: true };
}
