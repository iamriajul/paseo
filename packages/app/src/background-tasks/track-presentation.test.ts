import { describe, expect, it } from "vitest";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";
import { buildBackgroundTaskPillPresentation } from "./track-presentation";

const t = ((key: string, options?: Record<string, string | number>) => {
  switch (key) {
    case "backgroundTasks.pillCount":
      return `${options?.count ?? 0} shells`;
    case "backgroundTasks.pillCountAccessible":
      return `${options?.count ?? 0} background tasks`;
    case "backgroundTasks.pillCountRunningAccessible":
      return `${options?.count ?? 0} background tasks, ${options?.running ?? 0} running`;
    default:
      return key;
  }
}) as never;

function row(status: BackgroundTaskDescriptorPayload["status"]): BackgroundTaskDescriptorPayload {
  return {
    taskId: `task-${status}`,
    parentAgentId: "agent-1",
    type: "shell",
    status,
    description: "npm test",
    command: "npm test",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("background task pill presentation", () => {
  it("marks the pill running when any task is running", () => {
    const pill = buildBackgroundTaskPillPresentation(t, [row("running"), row("completed")]);
    expect(pill.segments).toEqual([{ bucket: "running", text: "2 shells" }]);
    expect(pill.accessibilityLabel).toBe("2 background tasks, 1 running");
  });

  it("draws no running mark when nothing is in flight", () => {
    const pill = buildBackgroundTaskPillPresentation(t, [row("completed"), row("failed")]);
    expect(pill.segments).toEqual([{ bucket: null, text: "2 shells" }]);
    expect(pill.accessibilityLabel).toBe("2 background tasks");
  });
});
