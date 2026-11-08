import type { WorkspaceLinkTarget } from "@getpaseo/protocol/workspace-link";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { findMainPreviewService } from "@/workspace-services/workspace-services";

export interface WorkspaceLinkHostState {
  connected: boolean;
  /** The host's workspace list has loaded, so a missing workspace is really gone. */
  workspacesHydrated: boolean;
  workspaces: Map<string, WorkspaceDescriptor> | null | undefined;
}

export type WorkspaceLinkOpen =
  | { kind: "host-unavailable" }
  | { kind: "workspace-missing" }
  | { kind: "navigate"; serverId: string; workspaceId: string; preview: "none" | "open" }
  | { kind: "preview-missing"; serverId: string; workspaceId: string };

/**
 * Decides what pressing a workspace link does. Before the host's workspace list
 * loads, navigation goes ahead and the workspace screen owns the loading and
 * missing states; the preview request waits there for the scripts.
 */
export function resolveWorkspaceLinkOpen(
  target: WorkspaceLinkTarget,
  host: WorkspaceLinkHostState | null,
): WorkspaceLinkOpen {
  if (!host?.connected) {
    return { kind: "host-unavailable" };
  }
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces: host.workspaces,
    workspaceId: target.workspaceId,
  });
  if (!workspaceKey) {
    return host.workspacesHydrated
      ? { kind: "workspace-missing" }
      : {
          kind: "navigate",
          serverId: target.serverId,
          workspaceId: target.workspaceId,
          preview: target.view === "preview" ? "open" : "none",
        };
  }
  const destination = { serverId: target.serverId, workspaceId: workspaceKey };
  if (target.view !== "preview") {
    return { kind: "navigate", ...destination, preview: "none" };
  }
  const scripts = host.workspaces?.get(workspaceKey)?.scripts ?? [];
  return findMainPreviewService(scripts)
    ? { kind: "navigate", ...destination, preview: "open" }
    : { kind: "preview-missing", ...destination };
}
