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
