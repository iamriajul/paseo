import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import {
  deriveTerminalActivityStatusBucket,
  type TerminalActivity,
} from "@getpaseo/protocol/terminal-activity";

import {
  isTerminalBackgroundTaskStatus,
  type BackgroundTaskDescriptor,
} from "../agent/background-tasks/store.js";
import type { ProviderHeartbeatDescriptor } from "../agent/provider-heartbeats/store.js";
import { isSameOrDescendantPath } from "../path-utils.js";

/**
 * Kinds of work that outlive the scheduled run that started them. Archiving the
 * run workspace kills every one of these: background tasks and heartbeats die
 * with their agent, terminals are killed by the archive, and a worktree archive
 * deletes the directory a later schedule was pointed at.
 */
export type ScheduleRunLiveWorkKind =
  | "background-task"
  | "provider-heartbeat"
  | "heartbeat"
  | "schedule"
  | "terminal"
  | "agent";

export interface ScheduleRunLiveWork {
  kind: ScheduleRunLiveWorkKind;
  id: string;
  label: string;
}

export interface ScheduleRunTerminalSnapshot {
  id: string;
  name: string;
  exited: boolean;
  activity: TerminalActivity | null;
}

export interface ScheduleRunAgentSnapshot {
  id: string;
  workspaceId: string | null;
  lifecycle: AgentLifecycleStatus;
}

export interface ScheduleRunLiveWorkInput {
  /** Agent the run created, or null when the run died before creating one. */
  agentId: string | null;
  workspaceId: string;
  /** Workspace directory, or null when the run record no longer carries one. */
  cwd: string | null;
  /** Isolation the run used. Only a worktree run has its directory deleted by the archive. */
  isolation: "local" | "worktree";
  backgroundTasks: readonly BackgroundTaskDescriptor[];
  providerHeartbeats: readonly ProviderHeartbeatDescriptor[];
  schedules: readonly StoredSchedule[];
  terminals: readonly ScheduleRunTerminalSnapshot[];
  agents: readonly ScheduleRunAgentSnapshot[];
}

function truncateLabel(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

function describeSchedule(schedule: StoredSchedule): string {
  return truncateLabel(schedule.name ?? schedule.prompt);
}

/**
 * A terminal sitting at a prompt is not work — killing it loses nothing, and
 * treating it as live would pin every workspace whose run ever opened a shell.
 * Only a terminal running a command or waiting on the user counts.
 */
function isTerminalBusy(terminal: ScheduleRunTerminalSnapshot): boolean {
  if (terminal.exited) {
    return false;
  }
  const bucket = deriveTerminalActivityStatusBucket(terminal.activity);
  return bucket === "running" || bucket === "needs_input";
}

/** Work still attached to a finished scheduled run's workspace. Empty means safe to archive. */
export function findScheduleRunLiveWork(input: ScheduleRunLiveWorkInput): ScheduleRunLiveWork[] {
  return [
    ...findLiveBackgroundTasks(input.backgroundTasks),
    ...findLiveProviderHeartbeats(input.providerHeartbeats),
    ...findLiveSchedules(input),
    ...findLiveTerminals(input.terminals),
    ...findLiveAgents(input),
  ];
}

function findLiveBackgroundTasks(
  tasks: readonly BackgroundTaskDescriptor[],
): ScheduleRunLiveWork[] {
  // "unknown" is not a terminal status: an unreported task is assumed alive.
  return tasks
    .filter((task) => !isTerminalBackgroundTaskStatus(task.status))
    .map((task) => ({
      kind: "background-task" as const,
      id: task.taskId,
      label: truncateLabel(task.description || task.command || task.type),
    }));
}

function findLiveProviderHeartbeats(
  heartbeats: readonly ProviderHeartbeatDescriptor[],
): ScheduleRunLiveWork[] {
  return heartbeats.map((heartbeat) => ({
    kind: "provider-heartbeat" as const,
    id: heartbeat.taskId,
    label: truncateLabel(heartbeat.scheduleLabel || heartbeat.prompt),
  }));
}

function findLiveSchedules(input: ScheduleRunLiveWorkInput): ScheduleRunLiveWork[] {
  // A local run shares its cwd with the schedule that started it, and archiving it
  // leaves the directory in place. Only a worktree archive deletes the directory
  // out from under a schedule that was pointed at it.
  const worktreeCwd = input.isolation === "worktree" ? input.cwd : null;
  const live: ScheduleRunLiveWork[] = [];
  for (const schedule of input.schedules) {
    // A paused heartbeat is still owned by the agent; the user can resume it.
    if (schedule.status === "completed") {
      continue;
    }
    if (schedule.target.type === "agent") {
      if (input.agentId && schedule.target.agentId === input.agentId) {
        live.push({ kind: "heartbeat", id: schedule.id, label: describeSchedule(schedule) });
      }
      continue;
    }
    if (worktreeCwd && isSameOrDescendantPath(worktreeCwd, schedule.target.config.cwd)) {
      live.push({ kind: "schedule", id: schedule.id, label: describeSchedule(schedule) });
    }
  }
  return live;
}

function findLiveTerminals(
  terminals: readonly ScheduleRunTerminalSnapshot[],
): ScheduleRunLiveWork[] {
  return terminals.filter(isTerminalBusy).map((terminal) => ({
    kind: "terminal" as const,
    id: terminal.id,
    label: truncateLabel(terminal.name),
  }));
}

function findLiveAgents(input: ScheduleRunLiveWorkInput): ScheduleRunLiveWork[] {
  return input.agents
    .filter(
      (agent) =>
        agent.id !== input.agentId &&
        agent.workspaceId === input.workspaceId &&
        (agent.lifecycle === "running" || agent.lifecycle === "initializing"),
    )
    .map((agent) => ({ kind: "agent" as const, id: agent.id, label: agent.id }));
}
