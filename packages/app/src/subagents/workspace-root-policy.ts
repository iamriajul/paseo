import { isSideQuestionAgent } from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

type WorkspaceAgent = Pick<Agent, "parentAgentId" | "workspaceId"> & Partial<Pick<Agent, "labels">>;

export function isWorkspaceRootAgent(
  agent: WorkspaceAgent,
  parentAgent: Pick<Agent, "workspaceId"> | undefined,
): boolean {
  // A side question lives under its chat: no tab of its own, no row in the sidebar or the status.
  if (isSideQuestionAgent(agent)) {
    return false;
  }
  if (!agent.parentAgentId) {
    return true;
  }

  const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
  const parentWorkspaceId = normalizeWorkspaceOpaqueId(parentAgent?.workspaceId);
  return Boolean(workspaceId && parentWorkspaceId && workspaceId !== parentWorkspaceId);
}
