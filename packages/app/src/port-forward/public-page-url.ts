import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { resolveWebBrowserSrc } from "@/desktop/browser/pane/web-preview-url";
import { findServiceForBrowserUrl } from "@/utils/workspace-script-links";

/**
 * Where a tab's page can be opened by a browser that is not on the host: a phone's own browser,
 * any browser on iOS, the web build. Loopback URLs need a public origin the host serves.
 */
export type PublicPageUrl =
  | { kind: "direct"; url: string }
  /** The host's browser preview template: every loopback port, `Host` forged to localhost. */
  | { kind: "preview"; url: string }
  /** The service proxy's public alias of the paseo.json service on that port. */
  | { kind: "service"; url: string; serviceName: string }
  | { kind: "none"; port: number };

export function resolvePublicPageUrl(input: {
  url: string;
  previewTemplate: string | null;
  scripts: readonly WorkspaceScriptPayload[];
}): PublicPageUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const resolved = resolveWebBrowserSrc({ url: input.url, template: input.previewTemplate });
  if (resolved.kind === "direct") return { kind: "direct", url: input.url };
  if (resolved.kind === "preview") return { kind: "preview", url: resolved.src };
  const service = findServiceForBrowserUrl({ url: input.url, scripts: input.scripts });
  const publicBase = service?.publicProxyUrl;
  if (service && publicBase) {
    const target = new URL(publicBase);
    target.pathname = parsed.pathname;
    target.search = parsed.search;
    target.hash = parsed.hash;
    return { kind: "service", url: target.toString(), serviceName: service.scriptName };
  }
  return { kind: "none", port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) };
}
