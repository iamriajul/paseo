export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonDocument =
  | { status: "ok"; root: JsonValue }
  | { status: "error"; message: string; line: number | null };

/** JSON Lines files: one value per line. */
export function isJsonLinesPath(path: string): boolean {
  return /\.(jsonl|ndjson)$/i.test(path);
}

/**
 * Parses a JSON file the way editors read config files: comments and trailing commas are allowed
 * (tsconfig.json, VS Code settings). A JSON Lines file becomes an object keyed by line number.
 */
export function parseJsonDocument(text: string, jsonLines: boolean): JsonDocument {
  if (!jsonLines) return parseJsonc(text, null);
  const root: Record<string, JsonValue> = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") continue;
    const line = parseJsonc(lines[index], index);
    if (line.status === "error") return line;
    root[String(index + 1)] = line.root;
  }
  return { status: "ok", root };
}

/** `line` is the file line a JSON Lines value sits on; null for a whole file. */
function parseJsonc(text: string, line: number | null): JsonDocument {
  const json = stripJsonExtensions(text);
  try {
    return { status: "ok", root: JSON.parse(json) as JsonValue };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (line !== null) return { status: "error", message, line: line + 1 };
    const position = /position (\d+)/.exec(message);
    const errorLine = position ? json.slice(0, Number(position[1])).split("\n").length : null;
    return { status: "error", message, line: errorLine };
  }
}

/**
 * Blanks comments and trailing commas outside strings, keeping every other character in place so
 * a parse error's position still points into the file.
 */
export function stripJsonExtensions(text: string): string {
  const out = text.split("");
  let lastSignificant = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = stringEnd(text, index);
      lastSignificant = end - 1;
      index = end - 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") out[index++] = " ";
      index -= 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close < 0 ? text.length : close + 2;
      for (; index < end; index += 1) if (text[index] !== "\n") out[index] = " ";
      index -= 1;
    } else if (char === "}" || char === "]") {
      if (lastSignificant >= 0 && text[lastSignificant] === ",") out[lastSignificant] = " ";
      lastSignificant = index;
    } else if (!/\s/.test(char)) lastSignificant = index;
  }
  return out.join("");
}

function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === '"') return index + 1;
  }
  return text.length;
}

/** One line of the tree: a key and its value, under the containers that are open. */
export interface JsonRow {
  /** The value's path from the root, unique in the document. */
  id: string;
  depth: number;
  /** The property name, the array index, or null for a root value that is not a container. */
  key: string | number | null;
  value: JsonValue;
  /** Entries in an object or array; null for other values. */
  size: number | null;
}

/** The rows on screen: the root's entries, and the entries of every open container below them. */
export function visibleJsonRows(root: JsonValue, open: ReadonlySet<string>): JsonRow[] {
  const rows: JsonRow[] = [];
  if (!isContainer(root)) {
    rows.push({ id: "", depth: 0, key: null, value: root, size: null });
    return rows;
  }
  const visit = (value: JsonValue, id: string, depth: number) => {
    for (const [key, child] of entries(value)) {
      const childId = childPath(id, key);
      const size = isContainer(child) ? entries(child).length : null;
      rows.push({ id: childId, depth, key, value: child, size });
      if (size !== null && open.has(childId)) visit(child, childId, depth + 1);
    }
  };
  visit(root, "", 0);
  return rows;
}

/** Up to this many values, the tree opens with every container open, like the pretty file. */
const OPEN_ALL_MAX_VALUES = 1500;

/** Every container in a small document, none in a large one, so its first screen is its outline. */
export function initiallyOpen(root: JsonValue): Set<string> {
  const ids: string[] = [];
  let values = 0;
  const visit = (value: JsonValue, id: string): boolean => {
    for (const [key, child] of entries(value)) {
      values += 1;
      if (values > OPEN_ALL_MAX_VALUES) return false;
      if (!isContainer(child)) continue;
      const childId = childPath(id, key);
      ids.push(childId);
      if (!visit(child, childId)) return false;
    }
    return true;
  };
  return isContainer(root) && visit(root, "") ? new Set(ids) : new Set();
}

export function isContainer(value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null;
}

/** A JSON Pointer, so keys holding "/" stay distinct. */
function childPath(parent: string, key: string | number): string {
  return `${parent}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function entries(value: JsonValue): [string | number, JsonValue][] {
  if (Array.isArray(value)) return value.map((child, index) => [index, child]);
  if (isContainer(value)) return Object.entries(value);
  return [];
}
