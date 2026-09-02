import { describe, expect, test } from "vitest";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";

import type { BackgroundTaskDescriptor } from "../agent/background-tasks/store.js";
import type { ProviderHeartbeatDescriptor } from "../agent/provider-heartbeats/store.js";
import {
  findScheduleRunLiveWork,
  type ScheduleRunLiveWorkInput,
  type ScheduleRunTerminalSnapshot,
} from "./live-work.js";

const RUN_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_WORKSPACE_ID = "wks_run";
const RUN_CWD = "/tmp/paseo/worktrees/run";

function buildInput(overrides: Partial<ScheduleRunLiveWorkInput> = {}): ScheduleRunLiveWorkInput {
  return {
    agentId: RUN_AGENT_ID,
    workspaceId: RUN_WORKSPACE_ID,
    cwd: RUN_CWD,
    isolation: "worktree",
    backgroundTasks: [],
    providerHeartbeats: [],
    schedules: [],
    terminals: [],
    agents: [],
    ...overrides,
  };
}

function buildBackgroundTask(
  overrides: Partial<BackgroundTaskDescriptor> = {},
): BackgroundTaskDescriptor {
  return {
    taskId: "task-1",
    parentAgentId: RUN_AGENT_ID,
    type: "shell",
    description: "npm run build",
    command: "npm run build",
    status: "running",
    outputFile: null,
    lastSummary: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildProviderHeartbeat(
  overrides: Partial<ProviderHeartbeatDescriptor> = {},
): ProviderHeartbeatDescriptor {
  return {
    taskId: "cron-1",
    parentAgentId: RUN_AGENT_ID,
    provider: "claude",
    prompt: "check the deploy",
    mode: "recurring",
    scheduleLabel: "*/5 * * * *",
    nextHint: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildSchedule(overrides: Partial<StoredSchedule> = {}): StoredSchedule {
  return {
    id: "sch-1",
    name: null,
    prompt: "keep watching",
    cadence: { type: "every", everyMs: 60_000 },
    target: { type: "agent", agentId: RUN_AGENT_ID },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: "2026-01-01T00:01:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
    ...overrides,
  };
}

function buildTerminal(
  overrides: Partial<ScheduleRunTerminalSnapshot> = {},
): ScheduleRunTerminalSnapshot {
  const activity: TerminalActivity = { state: "working", changedAt: 0 };
  return { id: "term-1", name: "bash", exited: false, activity, ...overrides };
}

describe("findScheduleRunLiveWork", () => {
  test("an idle run workspace has no live work", () => {
    expect(findScheduleRunLiveWork(buildInput())).toEqual([]);
  });

  test("a running background shell is live work", () => {
    expect(
      findScheduleRunLiveWork(buildInput({ backgroundTasks: [buildBackgroundTask()] })),
    ).toEqual([{ kind: "background-task", id: "task-1", label: "npm run build" }]);
  });

  test("a monitor with an unreported status is assumed live", () => {
    const live = findScheduleRunLiveWork(
      buildInput({
        backgroundTasks: [
          buildBackgroundTask({
            taskId: "task-monitor",
            type: "monitor",
            description: "errors in deploy.log",
            command: null,
            status: "unknown",
          }),
        ],
      }),
    );
    expect(live).toEqual([
      { kind: "background-task", id: "task-monitor", label: "errors in deploy.log" },
    ]);
  });

  test("finished background tasks are not live work", () => {
    const finished = (["completed", "failed", "stopped"] as const).map((status, index) =>
      buildBackgroundTask({ taskId: `task-${index}`, status }),
    );
    expect(findScheduleRunLiveWork(buildInput({ backgroundTasks: finished }))).toEqual([]);
  });

  test("a provider heartbeat is live work", () => {
    expect(
      findScheduleRunLiveWork(buildInput({ providerHeartbeats: [buildProviderHeartbeat()] })),
    ).toEqual([{ kind: "provider-heartbeat", id: "cron-1", label: "*/5 * * * *" }]);
  });

  test("a Paseo heartbeat targeting the run agent is live work, even paused", () => {
    const live = findScheduleRunLiveWork(
      buildInput({
        schedules: [
          buildSchedule({ id: "sch-active", name: "backstop" }),
          buildSchedule({ id: "sch-paused", name: "resumable", status: "paused" }),
          buildSchedule({ id: "sch-done", name: "burned down", status: "completed" }),
          buildSchedule({
            id: "sch-other-agent",
            target: { type: "agent", agentId: OTHER_AGENT_ID },
          }),
        ],
      }),
    );
    expect(live).toEqual([
      { kind: "heartbeat", id: "sch-active", label: "backstop" },
      { kind: "heartbeat", id: "sch-paused", label: "resumable" },
    ]);
  });

  test("a schedule pointed inside the worktree the archive would delete is live work", () => {
    const live = findScheduleRunLiveWork(
      buildInput({
        schedules: [
          buildSchedule({
            id: "sch-in-worktree",
            name: "nightly",
            target: {
              type: "new-agent",
              config: { provider: "claude", cwd: `${RUN_CWD}/packages` },
            },
          }),
          buildSchedule({
            id: "sch-elsewhere",
            target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp/other" } },
          }),
        ],
      }),
    );
    expect(live).toEqual([{ kind: "schedule", id: "sch-in-worktree", label: "nightly" }]);
  });

  test("a local run does not treat the schedule that started it as live work", () => {
    const live = findScheduleRunLiveWork(
      buildInput({
        isolation: "local",
        schedules: [
          buildSchedule({
            id: "sch-self",
            target: { type: "new-agent", config: { provider: "claude", cwd: RUN_CWD } },
          }),
        ],
      }),
    );
    expect(live).toEqual([]);
  });

  test("only a busy terminal is live work", () => {
    const live = findScheduleRunLiveWork(
      buildInput({
        terminals: [
          buildTerminal({ id: "term-working", name: "build" }),
          buildTerminal({
            id: "term-input",
            name: "prompt",
            activity: { state: "attention", attentionReason: "needs_input", changedAt: 0 },
          }),
          buildTerminal({
            id: "term-finished",
            activity: { state: "attention", attentionReason: "finished", changedAt: 0 },
          }),
          buildTerminal({ id: "term-idle", activity: { state: "idle", changedAt: 0 } }),
          buildTerminal({ id: "term-unreported", activity: null }),
          buildTerminal({ id: "term-exited", exited: true }),
        ],
      }),
    );
    expect(live).toEqual([
      { kind: "terminal", id: "term-working", label: "build" },
      { kind: "terminal", id: "term-input", label: "prompt" },
    ]);
  });

  test("a running sibling agent in the run workspace is live work", () => {
    const live = findScheduleRunLiveWork(
      buildInput({
        agents: [
          { id: RUN_AGENT_ID, workspaceId: RUN_WORKSPACE_ID, lifecycle: "running" },
          { id: "child-running", workspaceId: RUN_WORKSPACE_ID, lifecycle: "running" },
          { id: "child-starting", workspaceId: RUN_WORKSPACE_ID, lifecycle: "initializing" },
          { id: "child-idle", workspaceId: RUN_WORKSPACE_ID, lifecycle: "idle" },
          { id: "child-closed", workspaceId: RUN_WORKSPACE_ID, lifecycle: "closed" },
          { id: "elsewhere", workspaceId: "wks_other", lifecycle: "running" },
        ],
      }),
    );
    expect(live.map((row) => row.id)).toEqual(["child-running", "child-starting"]);
  });

  test("a run that never created an agent has no agent-scoped live work", () => {
    const live = findScheduleRunLiveWork(
      buildInput({
        agentId: null,
        schedules: [buildSchedule({ id: "sch-orphan" })],
      }),
    );
    expect(live).toEqual([]);
  });
});
