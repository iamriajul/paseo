import { describe, expect, it } from "vitest";
import {
  CADENCE_PRESET_OPTIONS,
  normalizeScheduleFormCadence,
  resolveCronPresetId,
  buildTimerCadence,
  buildTimerPresetCadence,
  resolveCronPresetDisplay,
} from "./schedule-cadence-options";

describe("schedule cadence form options", () => {
  it("offers the approved cron preset vocabulary", () => {
    expect(CADENCE_PRESET_OPTIONS.map((option) => option.label)).toEqual([
      "Every minute",
      "Every hour",
      "Daily 9:00",
      "Weekdays 9:00",
      "Mondays 9:00",
    ]);
  });

  it("maps interval cadences to cron cadences for the form", () => {
    expect(
      normalizeScheduleFormCadence({ type: "every", everyMs: 60_000 }, "Europe/Madrid"),
    ).toEqual({
      type: "cron",
      expression: "* * * * *",
      timezone: "Europe/Madrid",
    });
    expect(
      normalizeScheduleFormCadence({ type: "every", everyMs: 60 * 60_000 }, "Europe/Madrid"),
    ).toEqual({
      type: "cron",
      expression: "0 * * * *",
      timezone: "Europe/Madrid",
    });
    expect(
      normalizeScheduleFormCadence({ type: "every", everyMs: 24 * 60 * 60_000 }, "Europe/Madrid"),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "Europe/Madrid",
    });
  });

  it("maps unsupported intervals to the closest custom cron expression", () => {
    const cadence = normalizeScheduleFormCadence(
      { type: "every", everyMs: 5 * 60_000 },
      "Europe/Madrid",
    );

    expect(cadence).toEqual({
      type: "cron",
      expression: "*/5 * * * *",
      timezone: "Europe/Madrid",
    });
    expect(resolveCronPresetId(cadence)).toBe("custom");
  });

  it("builds a timer cadence from a minute delay", () => {
    const fixedNow = new Date("2026-10-12T14:00:00.000Z");
    const cadence = buildTimerCadence(30, "America/New_York", fixedNow);
    expect(cadence.type).toBe("cron");
    expect(cadence.timezone).toBe("America/New_York");
    expect(cadence.expression).toBe("30 10 12 10 *");
  });

  it("builds timer preset cadences", () => {
    const fixedNow = new Date("2026-10-12T14:00:00.000Z");
    const cadence = buildTimerPresetCadence("in-15m", "America/New_York", fixedNow);
    expect(cadence?.expression).toBe("15 10 12 10 *");
  });

  it("displays calendar date-time cron expressions with readable format", () => {
    const display = resolveCronPresetDisplay({
      type: "cron",
      expression: "30 14 12 10 *",
      timezone: "America/New_York",
    });
    expect(display.label).toBe("Oct 12 at 14:30 America/New_York");
  });
});
