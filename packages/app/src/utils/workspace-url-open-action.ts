import { isLoopbackHttpUrl, rewriteWithVscodeProxyUri } from "@/utils/localhost-url";

export type WorkspaceUrlOpenAction =
  | { kind: "browser"; url: string }
  | { kind: "external"; url: string };

export function resolveWorkspaceUrlOpenAction(input: {
  url: string;
  hasWorkspaceBrowser: boolean;
  vscodeProxyUri?: string | null;
}): WorkspaceUrlOpenAction {
  if (!isLoopbackHttpUrl(input.url)) {
    return { kind: "external", url: input.url };
  }

  if (input.hasWorkspaceBrowser) {
    return { kind: "browser", url: input.url };
  }

  return {
    kind: "external",
    url:
      rewriteWithVscodeProxyUri({
        url: input.url,
        vscodeProxyUri: input.vscodeProxyUri,
      }) ?? input.url,
  };
}

/**
 * The one routing decision for a clicked loopback link. Returns true when the
 * link was handled (a Browser tab opened or an external URL launched) and false
 * for non-loopback URLs, so callers keep their own handling for those.
 */
export function openWorkspaceLoopbackUrl(input: {
  url: string;
  hasWorkspaceBrowser: boolean;
  vscodeProxyUri?: string | null;
  openInBrowserTab?: ((url: string) => boolean) | null;
  openExternal: (url: string) => void;
}): boolean {
  if (!isLoopbackHttpUrl(input.url)) {
    return false;
  }
  const action = resolveWorkspaceUrlOpenAction(input);
  if (action.kind === "browser" && input.openInBrowserTab?.(action.url)) {
    return true;
  }
  // A refused Browser tab falls back to what the resolver picks without one,
  // never to dropping the click.
  const fallback =
    action.kind === "browser"
      ? resolveWorkspaceUrlOpenAction({ ...input, hasWorkspaceBrowser: false })
      : action;
  input.openExternal(fallback.url);
  return true;
}
