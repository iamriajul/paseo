import { normalizeHostHeader } from "../service-proxy.js";

const PLACEHOLDER = "{port}";
const MAX_DNS_LABEL_LENGTH = 63;
// Longest decimal port is 65535; used to size-check the label at config time.
const WIDEST_PORT = "65535";

export interface BrowserPreviewTemplate {
  readonly raw: string;
  buildUrl(port: number): string;
  matchHost(hostHeader: string | undefined): number | null;
}

function invalid(detail: string, raw: string): Error {
  return new Error(`Invalid PASEO_BROWSER_PREVIEW_URL_TEMPLATE: ${detail} (${raw})`);
}

export function parseBrowserPreviewTemplate(raw: string): BrowserPreviewTemplate {
  const trimmed = raw.trim();
  const occurrences = trimmed.split(PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw invalid(`template must contain ${PLACEHOLDER} exactly once`, raw);
  }

  // The placeholder must be inside the hostname. A path-positioned placeholder
  // would lose the port on every root-absolute subresource request. Checked
  // before the URL shape checks below: substituting the probe port into a
  // path-positioned placeholder also yields a non-root pathname, and this is
  // the more specific diagnosis of the two.
  const placeholderIndex = trimmed.indexOf(PLACEHOLDER);
  const schemeEnd = trimmed.indexOf("://");
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const authorityEnd = (() => {
    const rest = trimmed.slice(authorityStart);
    const cut = rest.search(/[/?#]/);
    return cut === -1 ? trimmed.length : authorityStart + cut;
  })();
  if (placeholderIndex < authorityStart || placeholderIndex >= authorityEnd) {
    throw invalid(`${PLACEHOLDER} must appear in the hostname`, raw);
  }

  // Substitute a probe port so the result is a parseable URL. The probe is the
  // widest port so the label length check covers the worst case.
  const probe = trimmed.replace(PLACEHOLDER, WIDEST_PORT);
  let probeUrl: URL;
  try {
    probeUrl = new URL(probe);
  } catch {
    throw invalid("template is not an absolute URL once the port is substituted", raw);
  }

  if (probeUrl.protocol !== "http:" && probeUrl.protocol !== "https:") {
    throw invalid("template must use http or https", raw);
  }
  if (probeUrl.pathname !== "/" || probeUrl.search !== "" || probeUrl.hash !== "") {
    throw invalid("template must not carry a path, query or fragment", raw);
  }
  if (probeUrl.username !== "" || probeUrl.password !== "") {
    throw invalid("template must not carry credentials", raw);
  }

  // Split the template's own authority around the placeholder rather than the
  // probe's: a hostname may legitimately contain "65535" elsewhere, and indexOf
  // would then split in the wrong place. Lowercased so Host matching compares
  // like for like, and the :port suffix dropped so matching ignores it.
  const authority = trimmed.slice(authorityStart, authorityEnd);
  const authorityHost = authority.replace(/:\d+$/, "");
  const [rawPrefix = "", rawSuffix = ""] = authorityHost.split(PLACEHOLDER);
  const hostPrefix = rawPrefix.toLowerCase();
  const hostSuffix = rawSuffix.toLowerCase();

  // The placeholder may sit in any label and anywhere within it, so measure the
  // label that actually contains it rather than assuming it is the first.
  const labelLength =
    (hostPrefix.split(".").pop() ?? "").length +
    WIDEST_PORT.length +
    (hostSuffix.split(".")[0] ?? "").length;
  if (labelLength > MAX_DNS_LABEL_LENGTH) {
    throw invalid(
      `the label containing ${PLACEHOLDER} exceeds ${MAX_DNS_LABEL_LENGTH} characters with a five-digit port`,
      raw,
    );
  }

  return {
    raw: trimmed,
    buildUrl(port: number): string {
      return trimmed.replace(PLACEHOLDER, String(port));
    },
    matchHost(hostHeader: string | undefined): number | null {
      if (!hostHeader) return null;
      const hostname = normalizeHostHeader(hostHeader);
      if (!hostname.startsWith(hostPrefix) || !hostname.endsWith(hostSuffix)) return null;
      const middle = hostname.slice(hostPrefix.length, hostname.length - hostSuffix.length);
      if (!/^[1-9]\d*$/.test(middle)) return null;
      const port = Number(middle);
      return port >= 1 && port <= 65535 ? port : null;
    },
  };
}
