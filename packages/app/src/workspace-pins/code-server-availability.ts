export function shouldShowCodeServerLauncher(input: {
  isElectron: boolean;
  codeServerUrlOpeners:
    | {
        localhostUrl?: string;
        externalUrl?: string;
      }
    | null
    | undefined;
}): boolean {
  return input.isElectron
    ? Boolean(input.codeServerUrlOpeners?.localhostUrl)
    : Boolean(input.codeServerUrlOpeners?.externalUrl);
}
