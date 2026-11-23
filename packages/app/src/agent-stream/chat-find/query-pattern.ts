/** One query grammar for every platform: whitespace in the query matches any whitespace run. */
export function findQueryPattern(query: string): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const source = trimmed
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(source, "giu");
}
