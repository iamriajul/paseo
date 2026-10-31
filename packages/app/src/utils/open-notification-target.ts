import { router, type Href } from "expo-router";
import { parseNotificationOpenTarget } from "@/notification-open";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildHostRootRoute } from "@/utils/host-routes";
import { navigateToAgent } from "@/utils/navigate-to-agent";

/**
 * Opens what an in-app attention interrupt points at, the same way a notification tap does
 * (`notification-open/react`): agents resolve their own workspace, terminals open in theirs.
 */
export function openNotificationTarget(data: unknown): void {
  const target = parseNotificationOpenTarget(data);
  if (target?.kind === "agent") {
    navigateToAgent({ serverId: target.serverId, agentId: target.agentId, pin: true });
    return;
  }
  if (target?.kind === "terminal") {
    navigateToWorkspace({
      serverId: target.serverId,
      workspaceId: target.workspaceId,
      target: { kind: "terminal", terminalId: target.terminalId },
    });
    return;
  }
  router.navigate((target ? buildHostRootRoute(target.serverId) : "/") as Href);
}
