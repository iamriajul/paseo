import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { trackHostTabClose } from "./host-tabs";

/**
 * Closing a server browser tab's workspace tab closes the tab on the host, for every client, as
 * the viewer's Close tab does: otherwise its page keeps running, stays in browser_list_tabs and
 * counts against the tab limit. Other clients' workspace tabs follow through
 * `useServerBrowserSync`. A host that is offline keeps the tab, so it comes back here when the
 * host does.
 */
export function closeServerBrowserTab(serverId: string, browserId: string): void {
  const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
  if (!client) return;
  const close = client.serverBrowserCloseTab(browserId);
  trackHostTabClose(serverId, browserId, close);
  close.catch((error: unknown) => {
    console.warn("[ServerBrowser] Failed to close the tab on the host", { browserId, error });
  });
}
