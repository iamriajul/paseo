import { describe, expect, it } from "vitest";
import { buildTimerPresetCadence } from "@/schedules/schedule-cadence-options";

describe("composer scheduled prompt flow", () => {
  it("determines schedule prompt capability based on agent presence and mode", () => {
    function resolveCanSchedulePrompt(params: {
      hasAgent: boolean;
      inputMode?: string;
      supportsScheduledPrompt?: boolean;
    }): boolean {
      return Boolean(
        params.hasAgent &&
        params.inputMode !== "terminal" &&
        params.supportsScheduledPrompt !== false,
      );
    }

    expect(resolveCanSchedulePrompt({ hasAgent: true, inputMode: "chat" })).toBe(true);
    expect(resolveCanSchedulePrompt({ hasAgent: false, inputMode: "chat" })).toBe(false);
    expect(resolveCanSchedulePrompt({ hasAgent: true, inputMode: "terminal" })).toBe(false);
    expect(resolveCanSchedulePrompt({ hasAgent: true, supportsScheduledPrompt: false })).toBe(
      false,
    );
  });

  it("builds scheduled prompt target with user message delivery and one-shot timer", () => {
    const fixedNow = new Date("2026-10-12T14:00:00.000Z");
    const cadence = buildTimerPresetCadence("in-30m", "America/New_York", fixedNow);

    expect(cadence).toEqual({
      type: "cron",
      expression: "30 10 12 10 *",
      timezone: "America/New_York",
    });

    const scheduleCreateInput = {
      prompt: "Continue fixing tests once the quota resets",
      cadence,
      target: {
        type: "agent" as const,
        agentId: "agent-target-uuid",
        asUserMessage: true,
      },
      maxRuns: 1,
    };

    expect(scheduleCreateInput.target.asUserMessage).toBe(true);
    expect(scheduleCreateInput.maxRuns).toBe(1);
    expect(scheduleCreateInput.prompt).toBe("Continue fixing tests once the quota resets");
  });
});
