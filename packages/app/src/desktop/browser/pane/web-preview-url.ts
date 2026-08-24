import { buildBrowserPreviewUrl } from "@/desktop/browser/workspace-browser-preview";
import { isStandardLoopbackHostname, isUnspecifiedHostname } from "@/utils/localhost-url";

// Electron and Android both allowlist http/https before navigating to a URL. A
// "direct" src is the raw, unvalidated BrowserRecord.url, so an iframe needs the
// same check, or a stray javascript:/file: URL on a record flows straight into
// the DOM. ("preview" src is built from the host's own browserPreview.urlTemplate,
// a trusted, host-level setting, so it doesn't need this check.)
const ALLOWED_IFRAME_PROTOCOLS = new Set(["http:", "https:"]);

export function getUnsupportedIframeProtocol(src: string): string | null {
  try {
    const protocol = new URL(src).protocol;
    return ALLOWED_IFRAME_PROTOCOLS.has(protocol) ? null : protocol;
  } catch {
    return null;
  }
}

export type WebBrowserSrc =
  | { kind: "preview"; src: string }
  | { kind: "direct"; src: string }
  | { kind: "rejected"; reason: "unspecified-address" }
  | { kind: "no-template" };

export function resolveWebBrowserSrc(input: {
  url: string;
  template: string | null;
}): WebBrowserSrc {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { kind: "direct", src: input.url };
  }

  if (isUnspecifiedHostname(parsed.hostname)) {
    return { kind: "rejected", reason: "unspecified-address" };
  }
  if (!isStandardLoopbackHostname(parsed.hostname)) {
    return { kind: "direct", src: input.url };
  }
  if (!input.template) {
    return { kind: "no-template" };
  }

  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const base = new URL(buildBrowserPreviewUrl(input.template, port));
  base.pathname = parsed.pathname;
  base.search = parsed.search;
  base.hash = parsed.hash;
  return { kind: "preview", src: base.toString() };
}
