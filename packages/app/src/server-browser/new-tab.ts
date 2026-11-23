import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { openHostTab } from "./host-tabs";

/** The page a server tab opened from the launcher starts on: blank, with its URL bar focused. */
export const NEW_SERVER_TAB_URL = "about:blank";

/**
 * Opens a server browser tab in the workspace from the launcher or header, on a blank page the
 * user then types any URL into. Before this, server tabs came only from workspace URLs, agents and
 * popups, so a phone or web user without a link had no way to start one.
 */
export async function openNewServerBrowserTab(input: {
  client: Pick<DaemonClient, "serverBrowserOpenTab">;
  serverId: string;
  workspaceId: string;
  open: (target: { kind: "server_browser"; browserId: string }) => void;
}): Promise<void> {
  await openHostTab({
    client: input.client,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    url: NEW_SERVER_TAB_URL,
    place: input.open,
  });
}
