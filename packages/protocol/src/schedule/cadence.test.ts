import { describe, expect, it } from "vitest";
import { everyMsToFiveFieldCron, dateToCronExpression, getCronDateParts } from "./cadence.js";

describe("everyMsToFiveFieldCron", () => {
  it.each([
    [60_000, "*/1 * * * *"],
    [15 * 60_000, "*/15 * * * *"],
    [60 * 60_000, "0 * * * *"],
    [6 * 60 * 60_000, "0 */6 * * *"],
    [24 * 60 * 60_000, "0 0 * * *"],
  ])("converts %i milliseconds", (everyMs, cron) => {
    expect(everyMsToFiveFieldCron(everyMs)).toBe(cron);
  });

  it.each([30_000, 7 * 60_000, 5 * 60 * 60_000, 48 * 60 * 60_000])(
    "rejects unrepresentable interval %i",
    (everyMs) => {
      expect(everyMsToFiveFieldCron(everyMs)).toBeNull();
    },
  );
});

describe("dateToCronExpression and getCronDateParts", () => {
  it("converts a UTC date to 5-field cron", () => {
    const date = new Date("2026-10-12T14:35:00.000Z");
    const parts = getCronDateParts(date);
    expect(parts).toEqual({
      minute: 35,
      hour: 14,
      dayOfMonth: 12,
      month: 10,
      dayOfWeek: 1, // Monday
    });
    expect(dateToCronExpression(date)).toBe("35 14 12 10 *");
  });

  it("converts a date with specific timezone to 5-field cron", () => {
    const date = new Date("2026-10-12T14:35:00.000Z"); // 10:35 in EDT (UTC-4)
    const parts = getCronDateParts(date, "America/New_York");
    expect(parts.minute).toBe(35);
    expect(parts.hour).toBe(10);
    expect(parts.dayOfMonth).toBe(12);
    expect(parts.month).toBe(10);
    expect(dateToCronExpression(date, "America/New_York")).toBe("35 10 12 10 *");
  });
});
