export interface ByteRange {
  /** First byte. */
  start: number;
  /** Last byte, inclusive, as in a Range header. */
  end: number;
}

/** The response a media element gets for one request: status, headers, and the bytes to send. */
export interface RangeResponsePlan {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  /** `null` when the response has no body. */
  range: ByteRange | null;
}

/**
 * Answers a media element's Range header against a file of `size` bytes. Players ask for one
 * range at a time (`bytes=0-`, then the index at the end, then wherever the user seeks), so a
 * multi-range header is answered with the whole file, which RFC 9110 allows.
 */
export function planRangeResponse(input: {
  rangeHeader: string | null;
  size: number;
  mimeType: string;
}): RangeResponsePlan {
  const { size, mimeType } = input;
  const base = { "Content-Type": mimeType, "Accept-Ranges": "bytes" };
  const requested = parseSingleRange(input.rangeHeader, size);
  if (requested === "unsatisfiable") {
    return {
      status: 416,
      headers: { ...base, "Content-Range": `bytes */${size}`, "Content-Length": "0" },
      range: null,
    };
  }
  if (requested === null) {
    return {
      status: 200,
      headers: { ...base, "Content-Length": String(size) },
      range: size > 0 ? { start: 0, end: size - 1 } : null,
    };
  }
  return {
    status: 206,
    headers: {
      ...base,
      "Content-Range": `bytes ${requested.start}-${requested.end}/${size}`,
      "Content-Length": String(requested.end - requested.start + 1),
    },
    range: requested,
  };
}

function parseSingleRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header ?? "");
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    // A suffix range: the last N bytes.
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return null;
  return { start, end };
}
