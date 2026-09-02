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

  // A server bound to 0.0.0.0/:: is reachable at localhost, so treat the
  // unspecified addresses as loopback and route them through the template —
  // matching the desktop browser — rather than refusing them.
  const isLoopback =
    isStandardLoopbackHostname(parsed.hostname) || isUnspecifiedHostname(parsed.hostname);
  if (!isLoopback) {
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

// The inverse of resolveWebBrowserSrc's preview branch. The bridge reports the
// preview origin, but the address bar must keep showing the loopback URL the
// user asked for — the preview origin is transport, never something to display.
// The reported path is copied onto the original URL rather than the other way
// round, so whichever loopback spelling the user typed (localhost, 127.0.0.1,
// [::1]) survives instead of being normalised to one of them.
export function toDisplayUrl(input: {
  url: string;
  template: string | null;
  originalUrl: string;
}): string {
  if (!input.template) return input.url;

  let reported: URL;
  let original: URL;
  try {
    reported = new URL(input.url);
    original = new URL(input.originalUrl);
  } catch {
    return input.url;
  }

  const port = Number(original.port || (original.protocol === "https:" ? 443 : 80));
  let previewBase: URL;
  try {
    previewBase = new URL(buildBrowserPreviewUrl(input.template, port));
  } catch {
    return input.url;
  }
  if (reported.host !== previewBase.host) return input.url;

  original.pathname = reported.pathname;
  original.search = reported.search;
  original.hash = reported.hash;
  return original.toString();
}
