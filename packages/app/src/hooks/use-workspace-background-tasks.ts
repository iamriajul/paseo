import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { selectBackgroundTasksForParent, useBackgroundTaskStore } from "@/background-tasks/store";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";

export function useWorkspaceBackgroundTasks(input: {
  serverId: string;
  workspaceId: string;
}): BackgroundTaskDescriptorPayload[] {
  const agentId = useSessionStore(
    (state) =>
      state.sessions[input.serverId]?.workspaceAgentActivity.get(input.workspaceId)?.agentId ??
      null,
  );
  const tasks = useBackgroundTaskStore((state) => state.tasks);
  return useMemo(() => {
    if (!agentId) return [];
    return selectBackgroundTasksForParent(tasks, input.serverId, agentId);
  }, [agentId, tasks, input.serverId]);
}

export function useWorkspaceHasRunningBackgroundTasks(input: {
  serverId: string;
  workspaceId: string;
}): boolean {
  const rows = useWorkspaceBackgroundTasks(input);
  return useMemo(() => rows.some((row) => row.status === "running"), [rows]);
}
