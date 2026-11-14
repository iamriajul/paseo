export type TableDelimiter = "," | "\t";

/** The delimiter a table file's extension implies; null for files the table panel does not read. */
export function tableDelimiter(path: string): TableDelimiter | null {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "csv") return ",";
  if (extension === "tsv" || extension === "tab") return "\t";
  return null;
}

/**
 * Splits CSV or TSV text into rows (RFC 4180): a quoted field may hold the delimiter, line breaks
 * and doubled quotes. Blank lines are not rows. Malformed quoting never fails; the rest of the
 * field is read as written, so a broken file still shows.
 */
export function parseDelimited(text: string, delimiter: TableDelimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "" || fieldStarted) rows.push(row);
    row = [];
    field = "";
    fieldStarted = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      fieldStarted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRow();
    } else field += char;
  }
  if (field !== "" || row.length > 0 || fieldStarted) endRow();
  return rows;
}

export interface TableLayout {
  columns: number;
  /** Each column's width in characters. */
  widths: number[];
  /** Columns whose values are numbers, aligned to the end like a spreadsheet. */
  numeric: boolean[];
}

const SAMPLE_ROWS = 500;
const MIN_COLUMN_CHARS = 3;
const MAX_COLUMN_CHARS = 40;
const NUMBER = /^[-+]?(\d[\d,_]*)?(\.\d+)?([eE][-+]?\d+)?%?$/;

/** Sizes the columns from the header and the first rows, so a large file lays out at once. */
export function layoutTable(rows: readonly (readonly string[])[]): TableLayout {
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths = Array.from({ length: columns }, () => MIN_COLUMN_CHARS);
  const numbers = Array.from({ length: columns }, () => 0);
  const filled = Array.from({ length: columns }, () => 0);
  const sample = rows.slice(0, SAMPLE_ROWS + 1);
  sample.forEach((row, rowIndex) => {
    row.forEach((value, column) => {
      widths[column] = Math.min(MAX_COLUMN_CHARS, Math.max(widths[column], value.length));
      if (rowIndex === 0 || value === "") return;
      filled[column] += 1;
      if (/\d/.test(value) && NUMBER.test(value.trim())) numbers[column] += 1;
    });
  });
  const numeric = numbers.map(
    (count, column) => filled[column] > 0 && count / filled[column] >= 0.8,
  );
  return { columns, widths, numeric };
}
