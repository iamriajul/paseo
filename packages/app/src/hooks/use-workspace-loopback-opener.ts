import { useWorkspaceBrowserAvailability } from "@/desktop/browser/workspace-browser-availability";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useSessionStore } from "@/stores/session-store";
import { openExternalUrl } from "@/utils/open-external-url";
import { openWorkspaceLoopbackUrl } from "@/utils/workspace-url-open-action";

/**
 * Every surface that renders a clickable link inside a workspace routes loopback
 * URLs through this opener, so `http://localhost:3000` opens in the workspace
 * Browser wherever it appears (chat, question cards, plan cards, terminal, file
 * previews, ports). Returns false for non-loopback URLs.
 */
export function useWorkspaceLoopbackOpener(input: {
  serverId: string;
  openInBrowserTab?: ((url: string) => boolean) | null;
}): (url: string) => boolean {
  const hasWorkspaceBrowser = useWorkspaceBrowserAvailability(input.serverId);
  const vscodeProxyUri = useSessionStore(
    (state) => state.sessions[input.serverId]?.serverInfo?.urlOpeners?.vscodeProxyUri ?? null,
  );
  return useStableEvent((url: string) =>
    openWorkspaceLoopbackUrl({
      url,
      hasWorkspaceBrowser,
      vscodeProxyUri,
      openInBrowserTab: input.openInBrowserTab,
      openExternal: (target) => void openExternalUrl(target),
    }),
  );
}
