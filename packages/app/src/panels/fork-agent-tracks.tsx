import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { BackgroundTasksTrack } from "@/background-tasks/track";
import { useBackgroundTasksForParent } from "@/background-tasks/select";
import { refreshBackgroundTasks } from "@/background-tasks/store";
import { useStopBackgroundTask } from "@/background-tasks/use-stop-background-task";
import { HeartbeatsTrack } from "@/heartbeats/track";
import {
  mergeHeartbeatRows,
  selectPaseoHeartbeatRows,
  useProviderHeartbeatRows,
  type HeartbeatRow,
} from "@/heartbeats/select";
import { refreshProviderHeartbeats } from "@/heartbeats/provider-store";
import { useHeartbeatActions } from "@/heartbeats/use-heartbeat-actions";
import { ProviderHeartbeatDetailSheet } from "@/heartbeats/provider-detail-sheet";
import { ScheduleFormSheet } from "@/components/schedules/schedule-form-sheet";
import { useSchedules } from "@/hooks/use-schedules";
import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";

const EMPTY_AGGREGATED_SCHEDULES: AggregatedSchedule[] = [];

type HeartbeatScheduleFormState =
  | { mode: "closed" }
  | { mode: "create"; serverId: string; agentId: string }
  | { mode: "edit"; serverId: string; schedule: ScheduleSummary };

export const ForkAgentTracks = memo(function ForkAgentTracks({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { openTab } = usePaneContext();
  const backgroundTaskRows = useBackgroundTasksForParent({
    serverId,
    parentAgentId: agentId,
  });
  const { loadState: schedulesLoadState } = useSchedules();
  const schedulesForServer = useMemo(() => {
    if (schedulesLoadState.status !== "loaded") return EMPTY_AGGREGATED_SCHEDULES;
    return schedulesLoadState.data.filter((schedule) => schedule.serverId === serverId);
  }, [schedulesLoadState, serverId]);
  const paseoHeartbeatRows = useMemo(
    () =>
      selectPaseoHeartbeatRows({
        agentId,
        serverId,
        schedules: schedulesForServer,
      }),
    [agentId, schedulesForServer, serverId],
  );
  const providerHeartbeatRows = useProviderHeartbeatRows({
    serverId,
    parentAgentId: agentId,
  });
  const heartbeatRows = useMemo(
    () => mergeHeartbeatRows(paseoHeartbeatRows, providerHeartbeatRows),
    [paseoHeartbeatRows, providerHeartbeatRows],
  );
  const {
    pauseHeartbeat,
    resumeHeartbeat,
    deleteHeartbeat,
    pendingIds: heartbeatPendingIds,
  } = useHeartbeatActions({ serverId, parentAgentId: agentId });
  const [heartbeatScheduleForm, setHeartbeatScheduleForm] = useState<HeartbeatScheduleFormState>({
    mode: "closed",
  });
  const [providerHeartbeatDetail, setProviderHeartbeatDetail] = useState<Extract<
    HeartbeatRow,
    { kind: "provider" }
  > | null>(null);
  const supportsBackgroundTasks = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.backgroundTasks === true,
  );
  const supportsProviderHeartbeats = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerHeartbeats === true,
  );
  const sessionClient = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const { stopTask: stopBackgroundTask, stoppingTaskIds } = useStopBackgroundTask({
    serverId,
    parentAgentId: agentId,
  });

  const handleOpenBackgroundTask = useCallback(
    (taskId: string) => {
      openTab({ kind: "background_task", parentAgentId: agentId, taskId });
    },
    [agentId, openTab],
  );
  const handleOpenHeartbeat = useCallback(
    (row: HeartbeatRow) => {
      if (row.kind === "paseo") {
        const schedule = schedulesForServer.find((entry) => entry.id === row.id);
        if (!schedule) return;
        setHeartbeatScheduleForm({
          mode: "edit",
          serverId: row.serverId,
          schedule,
        });
        return;
      }
      setProviderHeartbeatDetail(row);
    },
    [schedulesForServer],
  );
  const closeHeartbeatScheduleForm = useCallback(() => {
    setHeartbeatScheduleForm({ mode: "closed" });
  }, []);
  const closeProviderHeartbeatDetail = useCallback(() => {
    setProviderHeartbeatDetail(null);
  }, []);
  const createHeartbeatAgentTarget = useMemo(() => {
    if (heartbeatScheduleForm.mode !== "create") {
      return undefined;
    }
    return { agentId: heartbeatScheduleForm.agentId };
  }, [heartbeatScheduleForm]);

  useEffect(() => {
    if (!sessionClient || !supportsBackgroundTasks) return;
    void refreshBackgroundTasks(sessionClient, serverId, agentId).catch(() => undefined);
  }, [agentId, serverId, sessionClient, supportsBackgroundTasks]);
  useEffect(() => {
    if (!sessionClient || !supportsProviderHeartbeats) return;
    void refreshProviderHeartbeats(sessionClient, serverId, agentId).catch(() => undefined);
  }, [agentId, serverId, sessionClient, supportsProviderHeartbeats]);

  if (heartbeatRows.length === 0 && backgroundTaskRows.length === 0) {
    return null;
  }

  return (
    <>
      <HeartbeatsTrack
        rows={heartbeatRows}
        onOpenRow={handleOpenHeartbeat}
        onPause={pauseHeartbeat}
        onResume={resumeHeartbeat}
        onDelete={deleteHeartbeat}
        pendingIds={heartbeatPendingIds}
      />
      {supportsBackgroundTasks ? (
        <BackgroundTasksTrack
          rows={backgroundTaskRows}
          onOpenTask={handleOpenBackgroundTask}
          onStopTask={stopBackgroundTask}
          stoppingTaskIds={stoppingTaskIds}
        />
      ) : null}
      <ScheduleFormSheet
        serverId={
          heartbeatScheduleForm.mode === "closed" ? undefined : heartbeatScheduleForm.serverId
        }
        visible={heartbeatScheduleForm.mode !== "closed"}
        onClose={closeHeartbeatScheduleForm}
        mode={heartbeatScheduleForm.mode === "edit" ? "edit" : "create"}
        schedule={
          heartbeatScheduleForm.mode === "edit" ? heartbeatScheduleForm.schedule : undefined
        }
        agentTarget={createHeartbeatAgentTarget}
      />
      <ProviderHeartbeatDetailSheet
        visible={providerHeartbeatDetail != null}
        row={providerHeartbeatDetail}
        onClose={closeProviderHeartbeatDetail}
      />
    </>
  );
});
