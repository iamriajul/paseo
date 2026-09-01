import { isLoopbackHttpUrl, rewriteWithVscodeProxyUri } from "@/utils/localhost-url";

interface CodeServerUrlOpeners {
  localhostUrl?: string;
  externalUrl?: string;
}

export function resolveCodeServerLaunchUrl(input: {
  isElectron: boolean;
  codeServerUrlOpeners: CodeServerUrlOpeners | null | undefined;
  vscodeProxyUri?: string | null;
  workspaceDirectory?: string | null;
}): string | null {
  const baseUrl = input.isElectron
    ? input.codeServerUrlOpeners?.localhostUrl
    : resolveExternalCodeServerUrl({
        codeServerUrlOpeners: input.codeServerUrlOpeners,
        vscodeProxyUri: input.vscodeProxyUri,
      });
  if (!baseUrl) {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    const workspaceDirectory = input.workspaceDirectory?.trim();
    if (workspaceDirectory) {
      url.searchParams.set("folder", workspaceDirectory);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function resolveExternalCodeServerUrl(input: {
  codeServerUrlOpeners: CodeServerUrlOpeners | null | undefined;
  vscodeProxyUri?: string | null;
}): string | null {
  const externalUrl = input.codeServerUrlOpeners?.externalUrl?.trim();
  if (externalUrl && !isLoopbackHttpUrl(externalUrl)) {
    return externalUrl;
  }

  const loopbackUrl = externalUrl || input.codeServerUrlOpeners?.localhostUrl;
  if (!loopbackUrl) {
    return null;
  }
  return rewriteWithVscodeProxyUri({
    url: loopbackUrl,
    vscodeProxyUri: input.vscodeProxyUri,
  });
}
