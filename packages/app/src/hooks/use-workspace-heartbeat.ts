import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useSchedules } from "@/hooks/use-schedules";
import {
  mergeHeartbeatRows,
  selectPaseoHeartbeatRows,
  useProviderHeartbeatRows,
  type HeartbeatRow,
} from "@/heartbeats/select";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

const EMPTY_AGGREGATED_SCHEDULES: Array<ScheduleSummary & { serverId: string }> = [];

export function useWorkspaceHeartbeatRows(input: {
  serverId: string;
  workspaceId: string;
}): HeartbeatRow[] {
  const agentId = useSessionStore(
    (state) =>
      state.sessions[input.serverId]?.workspaceAgentActivity.get(input.workspaceId)?.agentId ??
      null,
  );
  const { loadState: schedulesLoadState } = useSchedules();
  const schedulesForServer = useMemo(() => {
    if (schedulesLoadState.status !== "loaded") return EMPTY_AGGREGATED_SCHEDULES;
    return schedulesLoadState.data.filter((schedule) => schedule.serverId === input.serverId);
  }, [schedulesLoadState, input.serverId]);
  const paseoRows = useMemo(() => {
    if (!agentId) return [];
    return selectPaseoHeartbeatRows({
      agentId,
      serverId: input.serverId,
      schedules: schedulesForServer,
    });
  }, [agentId, input.serverId, schedulesForServer]);
  const providerRows = useProviderHeartbeatRows({
    serverId: input.serverId,
    parentAgentId: agentId ?? "",
  });
  return useMemo(() => {
    if (!agentId) return [];
    return mergeHeartbeatRows(paseoRows, providerRows);
  }, [agentId, paseoRows, providerRows]);
}
