import { describe, expect, it } from "vitest";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";
import { buildBackgroundTaskPillPresentation } from "./track-presentation";

const t = ((key: string, options?: { count?: number; running?: number }) => {
  if (key === "backgroundTasks.headerCountRunning") {
    return `Background Tasks (${options?.count ?? 0}) · ${options?.running ?? 0} running`;
  }
  if (key === "backgroundTasks.headerCount") {
    return `Background Tasks (${options?.count ?? 0})`;
  }
  return key;
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
    expect(pill.segments).toEqual([
      { bucket: "running", text: "Background Tasks (2) · 1 running" },
    ]);
  });

  it("draws no running mark when nothing is in flight", () => {
    const pill = buildBackgroundTaskPillPresentation(t, [row("completed")]);
    expect(pill.segments).toEqual([{ bucket: null, text: "Background Tasks (1)" }]);
  });
});
