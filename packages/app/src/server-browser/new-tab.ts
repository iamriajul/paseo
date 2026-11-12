import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** The page a server tab opened from the launcher starts on: blank, with its URL bar focused. */
export const NEW_SERVER_TAB_URL = "about:blank";

/**
 * Opens a server browser tab in the workspace from the launcher or header, on a blank page the
 * user then types any URL into. Before this, server tabs came only from workspace URLs, agents and
 * popups, so a phone or web user without a link had no way to start one.
 */
export async function openNewServerBrowserTab(input: {
  client: Pick<DaemonClient, "serverBrowserOpenTab">;
  workspaceId: string;
  open: (target: { kind: "server_browser"; browserId: string }) => void;
}): Promise<void> {
  const browserId = await input.client.serverBrowserOpenTab(input.workspaceId, NEW_SERVER_TAB_URL);
  input.open({ kind: "server_browser", browserId });
}
