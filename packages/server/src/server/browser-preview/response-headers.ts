import type { BrowserPreviewTemplate } from "./url-template.js";

// Removed so the preview can be embedded in an iframe on the proxy origin.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
]);

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

interface RewriteUrlOptions {
  targetPort: number;
  template: BrowserPreviewTemplate;
}

function rewriteAbsoluteUrl(value: string, options: RewriteUrlOptions): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value; // relative or malformed: leave for the browser to resolve
  }
  // URL keeps IPv6 hostnames bracketed; compare unbracketed.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return value;
  if (parsed.port !== String(options.targetPort)) return value;

  const base = new URL(options.template.buildUrl(options.targetPort));
  parsed.protocol = base.protocol;
  parsed.hostname = base.hostname;
  parsed.port = base.port;
  return parsed.toString();
}

function rewriteRefresh(value: string, options: RewriteUrlOptions): string {
  const match = /^(\s*[^;]*;\s*url=)(.*)$/i.exec(value);
  if (!match) return value;
  const [, head, target] = match;
  const unquoted = target.trim().replace(/^["']|["']$/g, "");
  const rewritten = rewriteAbsoluteUrl(unquoted, options);
  return rewritten === unquoted ? value : `${head}${rewritten}`;
}

export function transformPreviewResponseHeaders(options: {
  headers: NodeJS.Dict<string | string[]>;
  targetPort: number;
  template: BrowserPreviewTemplate;
}): NodeJS.Dict<string | string[]> {
  const { headers, ...urlOptions } = options;
  const out: NodeJS.Dict<string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    if (value === undefined) continue;

    if (lower === "location" || lower === "content-location") {
      out[name] = Array.isArray(value)
        ? value.map((v) => rewriteAbsoluteUrl(v, urlOptions))
        : rewriteAbsoluteUrl(value, urlOptions);
      continue;
    }
    if (lower === "refresh") {
      out[name] = Array.isArray(value)
        ? value.map((v) => rewriteRefresh(v, urlOptions))
        : rewriteRefresh(value, urlOptions);
      continue;
    }
    out[name] = value;
  }
  return out;
}
