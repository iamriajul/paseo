import { resolveCodeServerLaunchUrl } from "@/utils/code-server-url";

export function shouldShowCodeServerLauncher(input: {
  isElectron: boolean;
  codeServerUrlOpeners:
    | {
        localhostUrl?: string;
        externalUrl?: string;
      }
    | null
    | undefined;
  vscodeProxyUri?: string | null;
}): boolean {
  return Boolean(resolveCodeServerLaunchUrl(input));
}
