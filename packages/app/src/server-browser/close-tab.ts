import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * Closing a server browser tab's workspace tab closes the tab on the host, for every client, as
 * the viewer's Close tab does: otherwise its page keeps running, stays in browser_list_tabs and
 * counts against the tab limit. Other clients' workspace tabs follow through
 * `useServerBrowserSync`. A host that is offline keeps the tab until its idle close.
 */
export function closeServerBrowserTab(serverId: string, browserId: string): void {
  const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
  if (!client) return;
  void client.serverBrowserCloseTab(browserId).catch((error: unknown) => {
    console.warn("[ServerBrowser] Failed to close the tab on the host", { browserId, error });
  });
}
